"""Tests for H1 alias storage: fail-closed upsert, deactivate, conflict detection."""
from __future__ import annotations

import pytest

from finance_bridge.app.config import Settings
from finance_bridge.app.storage.sqlite import SQLiteStorage, ConflictError


class TestAliasFailClosedUpsert:
    def test_create_new(self, temp_storage):
        """Creating a new alias via fail-closed upsert should succeed."""
        alias_id, action = temp_storage.upsert_alias_fail_closed(
            "Bank D", "asset", "EUR", firefly_account_id=11
        )
        assert alias_id > 0
        assert action == "created"
        alias = temp_storage.get_alias("Bank D")
        assert alias is not None
        assert alias["account_type"] == "asset"
        assert alias["firefly_account_id"] == 11

    def test_idempotent_match(self, temp_storage):
        """Same upsert twice → action='matched', no error."""
        _, action1 = temp_storage.upsert_alias_fail_closed(
            "Bank D", "asset", "EUR", firefly_account_id=11
        )
        assert action1 == "created"
        _, action2 = temp_storage.upsert_alias_fail_closed(
            "Bank D", "asset", "EUR", firefly_account_id=11
        )
        assert action2 == "matched"

    def test_conflict_different_firefly_id(self, temp_storage):
        """Different firefly_account_id must raise ConflictError."""
        temp_storage.upsert_alias_fail_closed("Bank", "asset", "EUR", firefly_account_id=10)
        with pytest.raises(ConflictError, match="firefly_account_id differs"):
            temp_storage.upsert_alias_fail_closed("Bank", "asset", "EUR", firefly_account_id=20)

    def test_conflict_different_type(self, temp_storage):
        """Different account_type must raise ConflictError."""
        temp_storage.upsert_alias_fail_closed("Card", "asset", "EUR", firefly_account_id=10)
        with pytest.raises(ConflictError, match="account_type differs"):
            temp_storage.upsert_alias_fail_closed("Card", "liability", "EUR", firefly_account_id=10)

    def test_conflict_different_currency(self, temp_storage):
        """Different currency must raise ConflictError."""
        temp_storage.upsert_alias_fail_closed("Wallet", "asset", "EUR", firefly_account_id=10)
        with pytest.raises(ConflictError, match="currency differs"):
            temp_storage.upsert_alias_fail_closed("Wallet", "asset", "USD", firefly_account_id=10)

    def test_reactivate_deactivated(self, temp_storage):
        """Upsert on deactivated alias with same fields → reactivates."""
        temp_storage.upsert_alias_fail_closed("Old", "asset", "EUR", firefly_account_id=1)
        temp_storage.deactivate_alias("Old")
        assert temp_storage.get_alias("Old") is None  # inactive

        alias_id, action = temp_storage.upsert_alias_fail_closed(
            "Old", "asset", "EUR", firefly_account_id=1
        )
        assert action == "matched"
        alias = temp_storage.get_alias("Old")
        assert alias is not None
        assert alias["is_active"] == 1

    def test_deactivate_nonexistent(self, temp_storage):
        """Deactivating non-existent alias returns False."""
        assert temp_storage.deactivate_alias("Nope") is False

    def test_find_by_firefly_id(self, temp_storage):
        """Find aliases by Firefly ID."""
        temp_storage.upsert_alias_fail_closed("A", "asset", "EUR", firefly_account_id=1)
        temp_storage.upsert_alias_fail_closed("B", "asset", "EUR", firefly_account_id=1)
        results = temp_storage.find_aliases_by_firefly_id(1)
        assert len(results) == 2

    def test_list_inactive(self, temp_storage):
        """list_aliases(include_inactive=True) works."""
        temp_storage.upsert_alias_fail_closed("Active", "asset", "EUR")
        temp_storage.upsert_alias_fail_closed("Inactive", "liability", "USD")
        temp_storage.deactivate_alias("Inactive")
        assert len(temp_storage.list_aliases(include_inactive=True)) == 2
        assert len(temp_storage.list_aliases(include_inactive=False)) == 1
