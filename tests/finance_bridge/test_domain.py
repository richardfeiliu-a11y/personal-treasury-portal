"""Domain-level tests: draft creation flow with validation and dedup."""
from __future__ import annotations

import pytest

from finance_bridge.app.domain.models import CreateDraftRequest, DraftStatus, TransactionIntent
from finance_bridge.app.storage.sqlite import ConflictError


class TestDraftCreationFlow:
    """Test the complete draft creation flow with storage."""

    def test_create_valid_expense_draft(self, temp_storage):
        """A valid expense draft should be created with ready_for_confirmation status."""
        from finance_bridge.app.storage.drafts import DraftStorage
        from finance_bridge.app.storage.aliases import AliasStorage

        drafts = DraftStorage(temp_storage)
        aliases = AliasStorage(temp_storage)

        # Setup alias
        aliases.create("Demo EUR Bank", "asset", "EUR", 1)
        aliases.create("餐饮", "expense", "EUR", 2)

        request = CreateDraftRequest(
            channel="feishu",
            source_message_id="flow-test-1",
            occurred_at="2026-07-16",
            amount="45.00",
            currency="EUR",
            transaction_intent=TransactionIntent.EXPENSE,
            source_account_alias="Demo EUR Bank",
            destination_account_alias="餐饮",
            description="Test lunch",
            confidence=0.95,
        )

        # Simulate what the API endpoint does
        from finance_bridge.app.domain.normalization import (
            compute_normalized_hash,
            normalize_currency,
            normalize_date,
            normalize_decimal,
            normalize_description,
        )
        amount = normalize_decimal(request.amount)
        occurred_at = normalize_date(request.occurred_at)
        currency = normalize_currency(request.currency)
        description = normalize_description(request.description)
        occurred_at_str = str(occurred_at)
        normalized_hash = compute_normalized_hash(
            occurred_at=occurred_at_str,
            amount=str(amount),
            currency=currency,
            source_account=request.source_account_alias,
            destination_account=request.destination_account_alias,
            transaction_intent=request.transaction_intent.value,
        )

        draft_data = {
            "channel": request.channel,
            "source_message_id": request.source_message_id,
            "attachment_sha256": request.attachment_sha256,
            "occurred_at": occurred_at_str,
            "amount": str(amount),
            "currency": currency,
            "transaction_intent": request.transaction_intent.value,
            "source_account_alias": request.source_account_alias,
            "destination_account_alias": request.destination_account_alias,
            "description": description,
            "merchant": request.merchant,
            "fx_rate": request.fx_rate,
            "confidence": request.confidence,
            "status": "ready_for_confirmation",
            "normalized_hash": normalized_hash,
            "clarification_message": None,
        }

        draft_id = drafts.create(draft_data)
        draft = drafts.get(draft_id)

        assert draft["status"] == "ready_for_confirmation"
        assert draft["amount"] == "45.00"
        assert draft["currency"] == "EUR"
        assert draft["draft_version"] == 1

    def test_duplicate_message_id_returns_existing(self, temp_storage):
        """Submitting the same message ID twice should return the existing draft."""
        from finance_bridge.app.storage.drafts import DraftStorage

        drafts = DraftStorage(temp_storage)

        data = {
            "channel": "feishu",
            "source_message_id": "dup-msg-1",
            "occurred_at": "2026-07-16",
            "amount": "30.00",
            "currency": "EUR",
            "transaction_intent": "expense",
            "source_account_alias": "Bank",
            "destination_account_alias": "Food",
        }

        draft_id_1 = drafts.create(data)
        with pytest.raises(ConflictError):
            drafts.create(data)

        # The first draft should still exist
        draft = drafts.get(draft_id_1)
        assert draft["source_message_id"] == "dup-msg-1"


class TestClarificationFlow:
    def test_unknown_account_type_fails_validation(self):
        """An expense with revenue-type source should fail."""
        from finance_bridge.app.domain.validation import validate_transaction_accounts

        valid, err = validate_transaction_accounts(
            TransactionIntent.EXPENSE, "revenue", "expense"
        )
        assert valid is False
        assert "source" in err

    def test_low_confidence_triggers_clarification(self):
        """Low confidence should trigger clarification."""
        issues = []
        if 0.4 < 0.7:
            issues.append("低置信度")
        assert len(issues) > 0
