"""Confirmation API endpoints.

H2: Proper idempotency and posting_unknown recovery.
- Check external_id before posting to Firefly
- Found → recover (fill firefly_transaction_id, mark posted)
- Not found → post to Firefly
- Query failure → keep posting_unknown (do not re-post)

H2: Direction matrix determines Firefly type:
  asset→asset / liability→liability → transfer
  asset→liability → withdrawal
  liability→asset → deposit
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from finance_bridge.app.config import settings
from finance_bridge.app.domain.models import DraftStatus
from finance_bridge.app.firefly.client import FireflyClient
from finance_bridge.app.firefly.errors import FireflyValidationError
from finance_bridge.app.firefly.mapper import map_to_firefly_payload
from finance_bridge.app.storage.aliases import aliases
from finance_bridge.app.storage.drafts import drafts
from finance_bridge.app.storage.errors import StaleVersionError
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()


class ConfirmResponse(BaseModel):
    status: str
    firefly_transaction_id: str | None = None
    message: str | None = None
    warning: str | None = None


def _check_duplicate_transactions(client: FireflyClient, draft: dict) -> str | None:
    try:
        from datetime import datetime, timedelta
        occurred_at = draft.get("occurred_at")
        amount = draft.get("amount")
        if not occurred_at or not amount:
            return None
        dt = datetime.strptime(occurred_at, "%Y-%m-%d")
        start_date = (dt - timedelta(days=7)).strftime("%Y-%m-%d")
        end_date = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
        query = f"date_after:{start_date} date_before:{end_date} amount_is:{amount}"
        res = client._get("/search/transactions", params={"query": query})
        txns = res.get("data", [])
        if not txns:
            return None
        src_alias = (draft.get("source_account_alias") or "").lower()
        dst_alias = (draft.get("destination_account_alias") or "").lower()
        matched = []
        for item in txns:
            sub_txns = (item.get("attributes") or {}).get("transactions") or []
            for sub in sub_txns:
                sub_src = str(sub.get("source_name") or "").lower()
                sub_dst = str(sub.get("destination_name") or "").lower()
                if src_alias and dst_alias and (src_alias in sub_src or sub_src in src_alias) and (dst_alias in sub_dst or sub_dst in dst_alias):
                    matched.append(str(sub.get("transaction_journal_id") or item.get("id")))
        if matched:
            return f"Possible duplicate transaction found in Firefly (matching amount & accounts within last 7 days, IDs: {', '.join(matched)})"
    except Exception as e:
        logger.warning(
            "Duplicate check failed for draft %s: %s: %s",
            draft.get("id"), type(e).__name__, e,
            exc_info=True,
        )
    return None


@router.post("/drafts/{draft_id}/confirm", response_model=ConfirmResponse)
async def confirm_draft(draft_id: int) -> ConfirmResponse:
    """Confirm a draft transaction and post to Firefly.

    H2 Idempotency & Posting Failure Recovery:
    1. Look up draft, ensure state is confirmable.
    2. Query Firefly by external_id (`bridge-draft-{id}-v{version}`).
       - Found → transaction already posted (e.g. previous timeout after Firefly write).
                 Recover: mark posted with found firefly_transaction_id.
    3. Post to Firefly with external_id.
       - Success → mark posted, store firefly_transaction_id.
       - 422 → mark posting_failed
       - Error/Timeout → query by external_id:
         - Found → recover as posted
         - Not found → mark posting_failed
         - Query error → mark posting_unknown (do not re-post)
    """
    try:
        draft = drafts.get(draft_id)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Draft {draft_id} not found")

    status = DraftStatus(draft["status"])

    # Allow ready_for_confirmation, posting_unknown, posting_failed, confirming
    if status not in (DraftStatus.READY_FOR_CONFIRMATION, DraftStatus.POSTING_UNKNOWN, DraftStatus.POSTING_FAILED, DraftStatus.CONFIRMING):
        raise HTTPException(
            status_code=422,
            detail=f"Draft {draft_id} is in status '{draft['status']}'; expected confirmable status",
        )

    version = draft["draft_version"]

    try:
        # If already has a firefly_transaction_id and is posted/posted_unknown, recover
        if draft.get("firefly_transaction_id") and status in (DraftStatus.POSTING_UNKNOWN, DraftStatus.CONFIRMING):
            version = drafts.update_status(draft_id, DraftStatus.POSTED.value, version)
            return ConfirmResponse(
                status=DraftStatus.POSTED.value,
                firefly_transaction_id=str(draft["firefly_transaction_id"]),
                message="Recovered from pending state with existing firefly_transaction_id",
            )

        # Check Firefly credentials — fail closed：无凭据一律 503。
        # （原 development demo 分支把草稿伪造成 posted 并编造 firefly_transaction_id，
        # 污染状态机语义，A24 消融删除；owner 确认不需要 demo 入账。）
        if not settings.has_firefly_credentials:
            logger.error(
                "Firefly credentials not configured — refusing to confirm draft %s",
                draft_id,
            )
            raise HTTPException(
                status_code=503,
                detail="Firefly credentials not configured; refusing to confirm",
            )

        external_id = f"bridge-draft-{draft_id}-v{draft['draft_version']}"

        # Mark status as confirming before network call
        version = drafts.update_status(draft_id, DraftStatus.CONFIRMING.value, version)

        dup_warning: str | None = None

        # ---------------------------------------------------------------
        # Step 1: Duplicate check & external_id idempotency check
        # ---------------------------------------------------------------
        try:
            with FireflyClient(settings) as client:
                dup_warning = _check_duplicate_transactions(client, draft)
                existing = client.get_transaction_by_external_id(external_id)
        except Exception as e:
            logger.error("External ID query failed for draft %s: %s", draft_id, e)
            version = drafts.update_status(draft_id, DraftStatus.POSTING_UNKNOWN.value, version)
            return ConfirmResponse(
                status=DraftStatus.POSTING_UNKNOWN.value,
                firefly_transaction_id=None,
                message=f"External ID query failed: {e}",
                warning=dup_warning,
            )

        if existing:
            journal_id = _extract_firefly_id_from_response(existing)
            if journal_id:
                version = drafts.update_posted(draft_id, journal_id, version)
                logger.info("Draft %s → posted (Firefly journal %s)", draft_id, journal_id)
                return ConfirmResponse(
                    status=DraftStatus.POSTED.value,
                    firefly_transaction_id=journal_id,
                    message="Recovered: found existing transaction by external_id",
                    warning=dup_warning,
                )
            else:
                logger.warning("External ID %s found but no journal ID extracted", external_id)
                version = drafts.update_status(draft_id, DraftStatus.POSTING_UNKNOWN.value, version)
                return ConfirmResponse(
                    status=DraftStatus.POSTING_UNKNOWN.value,
                    firefly_transaction_id=None,
                    message="External ID query returned data but journal ID could not be extracted",
                    warning=dup_warning,
                )

        # ---------------------------------------------------------------
        # Step 2: Account mappings & payload mapping
        # ---------------------------------------------------------------
        source_alias_name = draft.get("source_account_alias")
        dest_alias_name = draft.get("destination_account_alias")
        source_account = aliases.get(source_alias_name) if source_alias_name else None
        dest_account = aliases.get(dest_alias_name) if dest_alias_name else None

        payload = map_to_firefly_payload(
            draft,
            source_account=source_account,
            destination_account=dest_account,
        )

        # ---------------------------------------------------------------
        # Step 3: Create transaction in Firefly
        # ---------------------------------------------------------------
        try:
            with FireflyClient(settings) as client:
                result = client.create_transaction(payload)
        except FireflyValidationError as e:
            version = drafts.update_status(draft_id, DraftStatus.POSTING_FAILED.value, version)
            logger.warning("Firefly validation failed for draft %s: %s", draft_id, e)
            return ConfirmResponse(
                status=DraftStatus.POSTING_FAILED.value,
                firefly_transaction_id=None,
                message=f"Firefly validation failed; amend the draft before confirming again: {e}",
                warning=dup_warning,
            )
        except Exception as e:
            logger.error("Failed to create Firefly transaction for draft %s: %s. Querying external_id...", draft_id, e)
            # Timeout/network error: fallback query by external_id
            try:
                with FireflyClient(settings) as client:
                    fallback_existing = client.get_transaction_by_external_id(external_id)
                if fallback_existing:
                    journal_id = _extract_firefly_id_from_response(fallback_existing)
                    if journal_id:
                        version = drafts.update_posted(draft_id, journal_id, version)
                        logger.info("Draft %s → posted (Firefly journal %s)", draft_id, journal_id)
                        return ConfirmResponse(
                            status=DraftStatus.POSTED.value,
                            firefly_transaction_id=journal_id,
                            message="Recovered via external_id query after create error",
                            warning=dup_warning,
                        )
                # Transaction definitely not created
                version = drafts.update_status(draft_id, DraftStatus.POSTING_FAILED.value, version)
                return ConfirmResponse(
                    status=DraftStatus.POSTING_FAILED.value,
                    firefly_transaction_id=None,
                    message=f"Firefly create failed and external_id was not found: {e}",
                    warning=dup_warning,
                )
            except Exception as query_err:
                logger.error("Fallback external_id query also failed for draft %s: %s", draft_id, query_err)
                version = drafts.update_status(draft_id, DraftStatus.POSTING_UNKNOWN.value, version)
                return ConfirmResponse(
                    status=DraftStatus.POSTING_UNKNOWN.value,
                    firefly_transaction_id=None,
                    message=f"Firefly create failed and fallback query failed: {query_err}",
                    warning=dup_warning,
                )

        journal_id = _extract_firefly_id_from_response(result)

        if journal_id:
            version = drafts.update_posted(draft_id, journal_id, version)
            logger.info("Draft %s → posted (Firefly journal %s)", draft_id, journal_id)
            return ConfirmResponse(
                status=DraftStatus.POSTED.value,
                firefly_transaction_id=journal_id,
                message="Transaction created in Firefly",
                warning=dup_warning,
            )
        else:
            logger.warning("Firefly create succeeded for draft %s but no journal ID extracted", draft_id)
            version = drafts.update_status(draft_id, DraftStatus.POSTING_UNKNOWN.value, version)
            return ConfirmResponse(
                status=DraftStatus.POSTING_UNKNOWN.value,
                firefly_transaction_id=None,
                message="Transaction created but journal ID could not be extracted",
                warning=dup_warning,
            )
    except StaleVersionError as exc:
        raise HTTPException(
            status_code=409,
            detail=f"Draft {draft_id} was modified concurrently, please refresh and retry",
        ) from exc



# -------------------------------------------------------------------
# H2: Extract journal ID from Firefly response
# -------------------------------------------------------------------

def _extract_firefly_id_from_response(result: dict) -> str | None:
    """Extract Firefly journal ID from response data.

    Priority order:
    1. result.attributes.transactions[0].transaction_journal_id
    2. result.transactions[0].transaction_journal_id
    'result' is the dict returned by FireflyClient.create_transaction() /
    get_transaction_by_external_id(), which already extracts the 'data'
    envelope（client 层已剥信封，A20 消融：原 Priority 3 的嵌套 data
    分支不可达，删除）。

    Returns None when no valid journal ID can be found — caller must NOT
    mark posted when journal ID is unavailable.
    """
    def _journal_id(container: dict) -> str | None:
        txns = container.get("transactions") or []
        if txns and isinstance(txns, list):
            first = txns[0] or {}
            tid = first.get("transaction_journal_id")
            if tid is not None:
                return str(tid)
        return None

    # Priority 1: result.attributes.transactions[0].transaction_journal_id
    attrs = result.get("attributes") or {}
    jid = _journal_id(attrs)
    if jid:
        return jid

    # Priority 2: result.transactions[0].transaction_journal_id
    jid = _journal_id(result)
    if jid:
        return jid

    return None
