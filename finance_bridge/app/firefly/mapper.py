"""Bridge model to Firefly API payload mapper.

H2: direction matrix determines Firefly transaction type based on
source AND destination account types, not just the Bridge intent.

| Source type | Dest type | Firefly type | Source ref | Dest ref |
|---|---|---|---|---|
| asset       | asset      | transfer     | source_id  | dest_id   |
| liability   | liability  | transfer     | source_id  | dest_id   |
| asset       | liability  | withdrawal   | source_id  | dest_id   |
| liability   | asset      | deposit      | source_id  | dest_id   |
| asset       | expense    | withdrawal   | source_id  | dest_name |
| liability   | expense    | withdrawal   | source_id  | dest_name |
| revenue     | asset      | deposit      | source_name| dest_id   |
| revenue     | liability  | deposit      | source_name| dest_id   |
| expense     | asset      | deposit      | source_name| dest_id   | (refund)
| expense     | liability  | deposit      | source_name| dest_id   | (refund)

Rules:
- asset + liability accounts ALWAYS use source_id / destination_id
- expense + revenue accounts use source_name / destination_name
- Refund is always tagged with "refund" tag
- Same end with ID provided → do NOT also send name (Firefox ignores name when id is present)
"""
from __future__ import annotations


def map_to_firefly_payload(
    draft: dict,
    source_account: dict | None = None,
    destination_account: dict | None = None,
    base_currency: str | None = None,
) -> dict:
    """Map a Bridge draft to Firefly transaction payload.

    Args:
        draft: Draft data from SQLite
        source_account: Full alias record for the source account
        destination_account: Full alias record for the destination account
        base_currency: Optional override for configured base currency

    Returns:
        Firefly API transaction payload dict
    """
    intent = draft["transaction_intent"]
    amount = str(draft["amount"])
    currency = draft["currency"]
    occurred_at = draft["occurred_at"]

    # External reference: always derived from Bridge, never from LLM
    external_id = f"bridge-draft-{draft['id']}-v{draft['draft_version']}"

    # Determine account types (defaults when no account info)
    src_type = (source_account or {}).get("account_type", "unknown")
    dst_type = (destination_account or {}).get("account_type", "unknown")

    # H2 direction matrix: deduce Firefly transaction type
    firefly_type = _deduce_firefly_type(intent, src_type, dst_type)

    # Base transaction structure
    transaction: dict = {
        "type": firefly_type,
        "date": occurred_at,
        "amount": amount,
        "currency_code": currency,
        "description": draft.get("description") or f"Draft {draft['id']}",
        "external_id": external_id,
        "process_date": occurred_at,
        "notes": f"Created by Finance Bridge. Draft: {draft['id']}",
    }

    # H2: Set source/destination references based on account types
    _set_source_ref(transaction, draft, source_account)
    _set_destination_ref(transaction, draft, destination_account)

    # H2: Do NOT send name when id is provided — Firefly ignores it
    if "source_id" in transaction and "source_name" in transaction:
        del transaction["source_name"]
    if "destination_id" in transaction and "destination_name" in transaction:
        del transaction["destination_name"]

    # The recorded amount stays in the source / transaction currency.  The
    # second amount is the corresponding amount in the receiving or base
    # currency.  Reversing these fields caused Firefly to reject GBP→CNY
    # transactions because its account-currency validation could not balance.
    if draft.get("foreign_amount") and draft.get("foreign_currency"):
        transaction["foreign_currency_code"] = draft["foreign_currency"]
        transaction["foreign_amount"] = str(draft["foreign_amount"])
        if draft.get("fx_rate_source"):
            transaction["notes"] += (
                f"\nFX: {draft['fx_rate_source']}"
                f"; rate_date={draft.get('fx_rate_date') or occurred_at}"
            )
    # Refund tagging — always add refund tag + accounting notes
    if intent == "refund":
        tags = transaction.get("tags", [])
        if isinstance(tags, list):
            tags.append("refund")
        else:
            tags = ["refund"]
        transaction["tags"] = tags
        transaction["notes"] = (
            transaction.get("notes", "")
            + "\nAccounting: refund — offsets original expense in P&L; not income."
        )

    # Merchant
    if draft.get("merchant"):
        transaction["notes"] = (transaction.get("notes") or "") + f"\nMerchant: {draft['merchant']}"

    # Confidence
    if draft.get("confidence") is not None:
        transaction["notes"] = (transaction.get("notes") or "") + f"\nLLM Confidence: {draft['confidence']:.0%}"

    return transaction


def _deduce_firefly_type(intent: str, src_type: str, dst_type: str) -> str:
    """Determine Firefly transaction type from Bridge intent + account types.

    H2 direction matrix:
    | source      | destination | Firefly type |
    | asset       | asset       | transfer     |
    | liability   | liability   | transfer     |
    | asset       | liability   | withdrawal   |
    | liability   | asset       | deposit      |
    | asset       | expense     | withdrawal   |
    | liability   | expense     | withdrawal   |
    | revenue     | asset       | deposit      |
    | revenue     | liability   | deposit      |
    | expense     | asset       | deposit      | (refund)
    | expense     | liability   | deposit      | (refund)
    """
    # Normalise types
    src_type = src_type.lower()
    dst_type = dst_type.lower()

    # Both ends are asset → transfer
    if src_type == "asset" and dst_type == "asset":
        return "transfer"
    # Both ends are liability → transfer
    if src_type == "liability" and dst_type == "liability":
        return "transfer"
    # Source asset, dest liability → withdrawal (pay credit card)
    if src_type == "asset" and dst_type == "liability":
        return "withdrawal"
    # Source liability, dest asset → deposit (credit refund/return)
    if src_type == "liability" and dst_type == "asset":
        return "deposit"
    # Source is asset/liability and dest is expense/revenue → withdrawal
    if src_type in ("asset", "liability") and dst_type in ("expense", "revenue"):
        return "withdrawal"
    # Source is revenue/expense and dest is asset/liability → deposit
    if src_type in ("revenue", "expense") and dst_type in ("asset", "liability"):
        return "deposit"
    # Fallback to intent-based mapping
    intent_map = {
        "expense": "withdrawal",
        "income": "deposit",
        "transfer": "transfer",
        "refund": "deposit",
    }
    return intent_map.get(intent.lower(), "withdrawal")


def _set_source_ref(transaction: dict, draft: dict, account: dict | None) -> None:
    """Set source_id or source_name based on account type."""
    alias = draft.get("source_account_alias", "")
    if not account:
        transaction["source_name"] = alias
        return

    acct_type = account.get("account_type", "unknown")
    ff_id = account.get("firefly_account_id")

    if acct_type in ("asset", "liability") and ff_id is not None:
        transaction["source_id"] = str(ff_id)
        # Do NOT set source_name when id is set — Firefly ignores it
    else:
        transaction["source_name"] = alias


def _set_destination_ref(transaction: dict, draft: dict, account: dict | None) -> None:
    """Set destination_id or destination_name based on account type."""
    alias = draft.get("destination_account_alias", "")
    if not account:
        transaction["destination_name"] = alias
        return

    acct_type = account.get("account_type", "unknown")
    ff_id = account.get("firefly_account_id")

    if acct_type in ("asset", "liability") and ff_id is not None:
        transaction["destination_id"] = str(ff_id)
        # Do NOT set destination_name when id is set
    else:
        transaction["destination_name"] = alias
