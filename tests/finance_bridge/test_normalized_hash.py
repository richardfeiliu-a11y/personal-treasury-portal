"""Tests for normalized transaction hash (7 天重复检测层数据指纹)。

原 test_idempotency.py：is_duplicate_request / is_key_expired /
compute_request_hash / generate_idempotency_key 随 A06 消融删除
（idempotency_keys 表 write-only，真幂等由 message_id 约束 + external_id
+ 7 天重复检测承担），仅保留 normalization 哈希测试。
"""
from __future__ import annotations

from finance_bridge.app.domain.normalization import compute_normalized_hash


class TestExternalId:
    def test_format(self):
        """External ID format: bridge-draft-{id}-v{version}."""
        eid = f"bridge-draft-{42}-v{3}"
        assert eid == "bridge-draft-42-v3"

    def test_version_change_changes_id(self):
        """Amending changes version, thus external_id changes."""
        id1 = f"bridge-draft-5-v1"
        id2 = f"bridge-draft-5-v2"
        assert id1 != id2

    def test_mapper_includes_external_id(self):
        """Mapper output has external_id."""
        from finance_bridge.app.firefly.mapper import map_to_firefly_payload
        draft = {"id": 1, "draft_version": 1, "transaction_intent": "expense",
                 "occurred_at": "2026-07-16", "amount": "45.00", "currency": "EUR",
                 "source_account_alias": "Bank", "destination_account_alias": "Food"}
        payload = map_to_firefly_payload(draft)
        assert payload["external_id"] == "bridge-draft-1-v1"


class TestNormalizedHash:
    def test_same_txn_same_hash(self):
        h1 = compute_normalized_hash("2026-07-16", "45.00", "EUR", "Bank", "Food", "expense")
        h2 = compute_normalized_hash("2026-07-16", "45.00", "EUR", "Bank", "Food", "expense")
        assert h1 == h2

    def test_different_amount_diff_hash(self):
        h1 = compute_normalized_hash("2026-07-16", "45.00", "EUR", "Bank", "Food", "expense")
        h2 = compute_normalized_hash("2026-07-16", "50.00", "EUR", "Bank", "Food", "expense")
        assert h1 != h2

    def test_case_insensitive_account(self):
        h1 = compute_normalized_hash("2026-07-16", "45.00", "EUR", "Bank", "Food", "expense")
        h2 = compute_normalized_hash("2026-07-16", "45.00", "EUR", "bank", "food", "expense")
        assert h1 == h2  # normalized lowercases accounts
