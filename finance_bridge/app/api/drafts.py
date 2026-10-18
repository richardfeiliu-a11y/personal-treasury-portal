"""Draft API endpoints."""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from finance_bridge.app.config import settings
from finance_bridge.app.domain.cross_currency import (
    CrossCurrencyValidationError,
    resolve_cross_currency,
)
from finance_bridge.app.domain.models import (
    AmendDraftRequest,
    CreateDraftRequest,
    DraftResponse,
    DraftStatus,
)
from finance_bridge.app.domain.normalization import (
    compute_normalized_hash,
    normalize_currency,
    normalize_date,
    normalize_decimal,
    normalize_description,
)
from finance_bridge.app.state import get_storage
from finance_bridge.app.storage.aliases import aliases
from finance_bridge.app.storage.audit import audit
from finance_bridge.app.storage.drafts import drafts
from finance_bridge.app.storage.errors import ConflictError
from finance_bridge.app.storage.fx_rates import FXRateRepository

logger = logging.getLogger("finance_bridge")

router = APIRouter()


@router.post("/drafts", response_model=DraftResponse, status_code=201)
async def create_draft(request: CreateDraftRequest) -> DraftResponse:
    """Create a new transaction draft.

    Returns existing draft if same message_id already processed (idempotent).
    """
    # Check for existing draft by message ID
    existing = drafts.find_by_message(request.channel, request.source_message_id)
    if existing:
        logger.info(f"Duplicate message_id {request.source_message_id}, returning existing draft {existing['id']}")
        return _to_response(existing, is_duplicate=True)

    # Normalize inputs
    try:
        amount = normalize_decimal(request.amount)
        occurred_at = normalize_date(request.occurred_at)
        currency = normalize_currency(request.currency)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Compute normalized hash for cross-reference dedup
    normalized_hash = compute_normalized_hash(
        occurred_at=occurred_at.isoformat(),
        amount=str(amount),
        currency=currency,
        source_account=request.source_account_alias,
        destination_account=request.destination_account_alias,
        transaction_intent=request.transaction_intent.value,
    )

    # Check for existing draft by normalized hash — advisory warning only.
    # Two legitimate same-amount transactions on the same day with the same
    # accounts are valid (e.g. two identical subway fares).  Hard idempotency
    # is enforced solely by channel+source_message_id and attachment_sha256.
    potential_duplicate_id: int | None = None
    existing_by_hash = drafts.find_by_normalized_hash(normalized_hash)
    if existing_by_hash and DraftStatus(existing_by_hash["status"]) not in (
        DraftStatus.CANCELLED, DraftStatus.POSTING_FAILED,
    ):
        potential_duplicate_id = existing_by_hash["id"]
        logger.info(
            f"Normalized hash matches existing draft {potential_duplicate_id}; "
            f"creating new draft with duplicate warning (not blocking)."
        )

    # Check attachment hash if present
    if request.attachment_sha256:
        existing_by_attach = drafts.find_by_attachment(request.attachment_sha256)
        if existing_by_attach:
            logger.info(f"Duplicate attachment, returning draft {existing_by_attach['id']}")
            return _to_response(existing_by_attach, is_duplicate=True)

    # Validate account aliases exist
    source_alias = aliases.get(request.source_account_alias)
    dest_alias = aliases.get(request.destination_account_alias)

    if not source_alias:
        raise HTTPException(status_code=422, detail=f"Unknown active source account: '{request.source_account_alias}'")
    if not dest_alias:
        raise HTTPException(status_code=422, detail=f"Unknown active destination account: '{request.destination_account_alias}'")

    from finance_bridge.app.domain.validation import validate_transaction_accounts
    valid, validation_error = validate_transaction_accounts(
        request.transaction_intent, source_alias["account_type"], dest_alias["account_type"]
    )
    if not valid:
        raise HTTPException(status_code=422, detail=validation_error)

    try:
        fx_fields = resolve_cross_currency(
            amount=amount,
            currency=currency,
            intent=request.transaction_intent.value,
            source_account=source_alias,
            destination_account=dest_alias,
            base_currency=settings.base_currency,
            occurred_at=occurred_at.isoformat(),
            settlement_amount=request.settlement_amount,
            settlement_currency=request.settlement_currency,
            explicit_fx_rate=request.fx_rate,
            rate_lookup=lambda code: FXRateRepository().latest_rate(code),
        )
    except CrossCurrencyValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    status = DraftStatus.READY_FOR_CONFIRMATION.value
    clarification = None

    # Advisory: warn about potential duplicate, but do NOT block creation
    if potential_duplicate_id is not None:
        clarification = (
            f"⚠️ 疑似重复：与草稿 #{potential_duplicate_id} 的日期、金额、币种、"
            f"账户和交易类型完全一致。如果确实是两笔独立交易（如同日两次相同金额消费），"
            f"可正常确认。"
        )

    # Create draft
    draft_data = {
        "channel": request.channel,
        "source_message_id": request.source_message_id,
        "attachment_sha256": request.attachment_sha256,
        "occurred_at": occurred_at,
        "amount": str(amount),
        "currency": currency,
        "transaction_intent": request.transaction_intent.value,
        "source_account_alias": request.source_account_alias,
        "destination_account_alias": request.destination_account_alias,
        "description": normalize_description(request.description),
        "merchant": request.merchant,
        **fx_fields,
        "confidence": request.confidence,
        "status": status,
        "normalized_hash": normalized_hash,
        "clarification_message": clarification,
    }

    try:
        draft_id = drafts.create(draft_data)
    except ConflictError:
        # Race window: the pre-check above missed a concurrent duplicate insert.
        # Idempotent semantics: return the already-stored draft instead of 500.
        logger.info(
            f"Duplicate message_id {request.source_message_id} hit UNIQUE "
            "constraint during create; returning existing draft."
        )
        existing = drafts.find_by_message(request.channel, request.source_message_id)
        if existing is None:
            raise HTTPException(
                status_code=500,
                detail="Draft conflict detected but existing draft not found",
            )
        return _to_response(existing, is_duplicate=True)

    # Record attachment hash
    if request.attachment_sha256:
        get_storage().create_attachment_hash(request.attachment_sha256, draft_id, request.channel)

    # Audit
    audit.record(
        actor=request.channel,
        action="create",
        object_type="draft",
        object_id=draft_id,
        new_values=draft_data,
    )

    created = drafts.get(draft_id)
    return _to_response(created, is_duplicate=False)


@router.get("/drafts/{draft_id}", response_model=DraftResponse)
async def get_draft(draft_id: int) -> DraftResponse:
    """Get a draft by ID."""
    try:
        draft = drafts.get(draft_id)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Draft {draft_id} not found")
    return _to_response(draft)


@router.patch("/drafts/{draft_id}", response_model=DraftResponse)
async def amend_draft(draft_id: int, request: AmendDraftRequest) -> DraftResponse:
    """Amend a draft before confirmation.

    Only drafts in ready_for_confirmation or needs_clarification can be amended.
    Increments draft_version.
    """
    try:
        draft = drafts.get(draft_id)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Draft {draft_id} not found")

    status = DraftStatus(draft["status"])
    if status in (
        DraftStatus.CONFIRMING,
        DraftStatus.CONFIRMED,
        DraftStatus.POSTING,
        DraftStatus.POSTED,
        DraftStatus.POSTING_UNKNOWN,
        DraftStatus.CANCELLED,
    ):
        raise HTTPException(
            status_code=422,
            detail=f"Cannot amend draft in status '{status.value}'",
        )

    # Build update dict
    updates: dict[str, Any] = {}
    if request.description is not None:
        from finance_bridge.app.domain.normalization import normalize_description
        updates["description"] = normalize_description(request.description)
    if request.amount is not None:
        from finance_bridge.app.domain.normalization import normalize_decimal
        updates["amount"] = str(normalize_decimal(request.amount))
    if request.currency is not None:
        from finance_bridge.app.domain.normalization import normalize_currency
        updates["currency"] = normalize_currency(request.currency)
    if request.occurred_at is not None:
        from finance_bridge.app.domain.normalization import normalize_date
        updates["occurred_at"] = str(normalize_date(request.occurred_at))
    if request.source_account_alias is not None:
        updates["source_account_alias"] = request.source_account_alias.strip()
    if request.destination_account_alias is not None:
        updates["destination_account_alias"] = request.destination_account_alias.strip()
    if request.merchant is not None:
        updates["merchant"] = request.merchant.strip()
    if request.fx_rate is not None:
        updates["fx_rate"] = request.fx_rate

    if not updates:
        raise HTTPException(status_code=422, detail="No fields to update")

    new_version = draft["draft_version"] + 1

    # Re-validate after amendments
    from finance_bridge.app.domain.models import TransactionIntent
    from finance_bridge.app.domain.validation import validate_transaction_accounts

    source_alias = aliases.get(updates.get("source_account_alias", draft["source_account_alias"]))
    dest_alias = aliases.get(updates.get("destination_account_alias", draft["destination_account_alias"]))

    if not source_alias:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown source account: '{updates.get('source_account_alias', draft['source_account_alias'])}'",
        )
    if not dest_alias:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown destination account: '{updates.get('destination_account_alias', draft['destination_account_alias'])}'",
        )

    valid, validation_error = validate_transaction_accounts(
        TransactionIntent(draft["transaction_intent"]), source_alias["account_type"], dest_alias["account_type"]
    )
    if not valid:
        raise HTTPException(status_code=422, detail=validation_error)

    effective_amount = updates.get("amount", draft["amount"])
    effective_currency = updates.get("currency", draft["currency"])
    effective_date = updates.get("occurred_at", draft["occurred_at"])
    # Preserve a user-supplied rate/settlement only when it remains the
    # authoritative source. ECB values are recalculated for an amended date.
    explicit_rate = request.fx_rate
    if explicit_rate is None and draft.get("fx_rate_source") == "user_rate":
        explicit_rate = draft.get("fx_rate")
    settlement_amount = request.settlement_amount
    settlement_currency = request.settlement_currency
    if settlement_amount is None and draft.get("fx_rate_source") == "user_settlement":
        settlement_amount = draft.get("foreign_amount")
        settlement_currency = draft.get("foreign_currency")
    try:
        updates.update(resolve_cross_currency(
            amount=normalize_decimal(effective_amount),
            currency=effective_currency,
            intent=draft["transaction_intent"],
            source_account=source_alias,
            destination_account=dest_alias,
            base_currency=settings.base_currency,
            occurred_at=str(effective_date),
            settlement_amount=settlement_amount,
            settlement_currency=settlement_currency,
            explicit_fx_rate=explicit_rate,
            rate_lookup=lambda code: FXRateRepository().latest_rate(code),
        ))
    except CrossCurrencyValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # Recompute normalized hash
    from finance_bridge.app.domain.normalization import compute_normalized_hash
    new_hash = compute_normalized_hash(
        occurred_at=updates.get("occurred_at", draft["occurred_at"]),
        amount=updates.get("amount", draft["amount"]),
        currency=updates.get("currency", draft["currency"]),
        source_account=updates.get("source_account_alias", draft["source_account_alias"]),
        destination_account=updates.get("destination_account_alias", draft["destination_account_alias"]),
        transaction_intent=draft["transaction_intent"],
    )
    updates["normalized_hash"] = new_hash

    # Move back to ready_for_confirmation if it was clarified
    if status in (DraftStatus.NEEDS_CLARIFICATION, DraftStatus.POSTING_FAILED):
        updates["status"] = DraftStatus.READY_FOR_CONFIRMATION.value
        updates["clarification_message"] = None

    amended = drafts.amend(draft_id, updates, new_version)

    audit.record(
        actor="api",
        action="amend",
        object_type="draft",
        object_id=draft_id,
        old_values=dict(draft),
        new_values=dict(amended),
    )

    return _to_response(amended)


from finance_bridge.app.storage.errors import StaleVersionError


@router.post("/drafts/{draft_id}/cancel", response_model=DraftResponse)
async def cancel_draft(draft_id: int) -> DraftResponse:
    """Cancel a draft."""
    try:
        draft = drafts.get(draft_id)
    except Exception:
        raise HTTPException(status_code=404, detail=f"Draft {draft_id} not found")

    status = DraftStatus(draft["status"])
    if status in (DraftStatus.POSTED, DraftStatus.CANCELLED):
        raise HTTPException(
            status_code=422,
            detail=f"Cannot cancel draft in status '{status.value}'",
        )

    old = dict(draft)
    try:
        drafts.update_status(draft_id, DraftStatus.CANCELLED.value, draft["draft_version"])
    except StaleVersionError as exc:
        raise HTTPException(
            status_code=409,
            detail=f"Draft {draft_id} was modified concurrently, please refresh and retry",
        ) from exc
    cancelled = drafts.get(draft_id)

    audit.record(
        actor="api",
        action="cancel",
        object_type="draft",
        object_id=draft_id,
        old_values=old,
        new_values=dict(cancelled),
    )

    return _to_response(cancelled)


def _to_response(draft: dict, is_duplicate: bool = False) -> DraftResponse:
    """Convert storage draft dict to API response model."""
    return DraftResponse(
        id=draft["id"],
        status=DraftStatus(draft["status"]),
        transaction_intent=draft["transaction_intent"],
        occurred_at=draft["occurred_at"],
        amount=draft["amount"],
        currency=draft["currency"],
        source_account_alias=draft["source_account_alias"],
        destination_account_alias=draft["destination_account_alias"],
        description=draft.get("description"),
        merchant=draft.get("merchant"),
        fx_rate=draft.get("fx_rate"),
        foreign_amount=draft.get("foreign_amount"),
        foreign_currency=draft.get("foreign_currency"),
        fx_rate_date=draft.get("fx_rate_date"),
        fx_rate_source=draft.get("fx_rate_source"),
        confidence=draft.get("confidence"),
        draft_version=draft["draft_version"],
        firefly_transaction_id=draft.get("firefly_transaction_id"),
        is_duplicate=is_duplicate,
        clarification_message=draft.get("clarification_message"),
        created_at=draft["created_at"],
        updated_at=draft["updated_at"],
    )
