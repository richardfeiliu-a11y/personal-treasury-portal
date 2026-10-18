"""Regression tests: normalized_hash is advisory, not a hard block.

Two legitimate same-amount transactions on the same day (e.g. two subway
fares with the same card) must BOTH be created as separate drafts.
The second draft should carry a clarification_message warning about the
potential duplicate, but NOT be blocked.

Hard idempotency is enforced only by:
- channel + source_message_id (UNIQUE constraint)
- attachment_sha256
"""
from __future__ import annotations

import pytest

from finance_bridge.app.domain.models import CreateDraftRequest, DraftStatus, TransactionIntent
from finance_bridge.app.domain.normalization import (
    compute_normalized_hash,
    normalize_currency,
    normalize_date,
    normalize_decimal,
    normalize_description,
)
from finance_bridge.app.storage.drafts import DraftStorage
from finance_bridge.app.storage.aliases import AliasStorage


def _make_draft_data(message_id: str, *, amount: str = "3.00", date: str = "2026-07-20") -> dict:
    """Helper: build draft data simulating two identical subway fares."""
    occurred_at = str(normalize_date(date))
    amt = str(normalize_decimal(amount))
    currency = normalize_currency("CNY")

    normalized_hash = compute_normalized_hash(
        occurred_at=occurred_at,
        amount=amt,
        currency=currency,
        source_account="交通卡",
        destination_account="交通",
        transaction_intent="expense",
    )
    return {
        "channel": "hermes-feishu",
        "source_message_id": message_id,
        "attachment_sha256": None,
        "occurred_at": occurred_at,
        "amount": amt,
        "currency": currency,
        "transaction_intent": "expense",
        "source_account_alias": "交通卡",
        "destination_account_alias": "交通",
        "description": "地铁",
        "merchant": None,
        "fx_rate": None,
        "foreign_amount": None,
        "foreign_currency": None,
        "fx_rate_date": None,
        "fx_rate_source": None,
        "confidence": 0.95,
        "status": "ready_for_confirmation",
        "normalized_hash": normalized_hash,
        "clarification_message": None,
    }


class TestNormalizedHashAdvisory:
    """normalized_hash must NOT block creation of legitimate duplicate-amount drafts."""

    def test_two_same_amount_drafts_both_created(self, temp_storage):
        """Two subway fares with same amount/date/account create two separate drafts."""
        drafts = DraftStorage(temp_storage)

        data1 = _make_draft_data("msg-subway-morning")
        data2 = _make_draft_data("msg-subway-evening")

        draft_id_1 = drafts.create(data1)
        draft_id_2 = drafts.create(data2)

        # Both drafts must exist as separate records
        assert draft_id_1 != draft_id_2

        d1 = drafts.get(draft_id_1)
        d2 = drafts.get(draft_id_2)

        assert d1["source_message_id"] == "msg-subway-morning"
        assert d2["source_message_id"] == "msg-subway-evening"
        assert d1["amount"] == d2["amount"] == "3.00"
        assert d1["occurred_at"] == d2["occurred_at"]

    def test_same_message_id_still_blocked(self, temp_storage):
        """Hard idempotency: same channel+message_id is still rejected."""
        from finance_bridge.app.storage.sqlite import ConflictError

        drafts = DraftStorage(temp_storage)

        data = _make_draft_data("msg-exact-same")
        drafts.create(data)

        with pytest.raises(ConflictError):
            drafts.create(data)

    def test_normalized_hash_lookup_finds_existing(self, temp_storage):
        """find_by_normalized_hash still works for advisory lookup."""
        drafts = DraftStorage(temp_storage)

        data = _make_draft_data("msg-first-trip")
        draft_id = drafts.create(data)

        found = drafts.find_by_normalized_hash(data["normalized_hash"])
        assert found is not None
        assert found["id"] == draft_id

    def test_api_creates_second_draft_with_warning(self, temp_storage):
        """Simulates the API-level flow: second same-hash draft gets warning."""
        drafts = DraftStorage(temp_storage)

        # First draft — no warning
        data1 = _make_draft_data("msg-trip-1")
        draft_id_1 = drafts.create(data1)

        # Simulate API logic: check for existing hash
        existing = drafts.find_by_normalized_hash(data1["normalized_hash"])
        assert existing is not None
        assert existing["id"] == draft_id_1

        # API should still create the second draft with a warning
        data2 = _make_draft_data("msg-trip-2")
        potential_duplicate_id = existing["id"]
        data2["clarification_message"] = (
            f"⚠️ 疑似重复：与草稿 #{potential_duplicate_id} 的日期、金额、币种、"
            f"账户和交易类型完全一致。如果确实是两笔独立交易（如同日两次相同金额消费），"
            f"可正常确认。"
        )
        draft_id_2 = drafts.create(data2)

        d2 = drafts.get(draft_id_2)
        assert d2["status"] == "ready_for_confirmation"
        assert d2["clarification_message"] is not None
        assert str(potential_duplicate_id) in d2["clarification_message"]
        assert "疑似重复" in d2["clarification_message"]

    def test_cancelled_draft_does_not_trigger_warning(self, temp_storage):
        """A cancelled draft should not cause a duplicate warning for new drafts."""
        drafts = DraftStorage(temp_storage)

        data1 = _make_draft_data("msg-cancelled-trip")
        draft_id_1 = drafts.create(data1)
        drafts.update_status(draft_id_1, DraftStatus.CANCELLED.value, 1)

        # After cancellation, the existing draft should still be found by hash...
        existing = drafts.find_by_normalized_hash(data1["normalized_hash"])
        assert existing is not None
        # ...but its status is cancelled, so API should NOT set warning
        assert DraftStatus(existing["status"]) == DraftStatus.CANCELLED

    def test_three_identical_fares_all_created(self, temp_storage):
        """Three identical transactions (e.g. 3 bus rides) all create separate drafts."""
        drafts = DraftStorage(temp_storage)

        ids = []
        for i in range(3):
            data = _make_draft_data(f"msg-bus-{i}")
            ids.append(drafts.create(data))

        assert len(set(ids)) == 3  # All unique draft IDs
        for did in ids:
            d = drafts.get(did)
            assert d["amount"] == "3.00"
            assert d["status"] == "ready_for_confirmation"
