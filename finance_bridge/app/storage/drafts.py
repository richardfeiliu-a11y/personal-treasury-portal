"""Draft-specific storage operations.

Delegates to the shared storage via get_storage() (lazy import to
avoid circular dependency with state.py). Accepts an optional explicit
storage for testing.
"""
from __future__ import annotations

from typing import Any


def _get_global_storage():
    from finance_bridge.app.state import get_storage
    return get_storage()


class DraftStorage:
    """Draft-specific operations on top of SQLiteStorage."""

    def __init__(self, storage=None):
        self._explicit = storage  # optional explicit storage for testing

    def _storage(self):
        return self._explicit if self._explicit is not None else _get_global_storage()

    def create(self, data: dict[str, Any]) -> int:
        return self._storage().create_draft(data)

    def get(self, draft_id: int) -> dict[str, Any]:
        return self._storage().get_draft(draft_id)

    def update_status(self, draft_id: int, status: str, version: int) -> int:
        return self._storage().update_draft_status(draft_id, status, version)

    def update_posted(self, draft_id: int, journal_id: str, version: int) -> int:
        return self._storage().update_draft_posted(draft_id, journal_id, version)

    def amend(self, draft_id: int, updates: dict[str, Any], new_version: int) -> dict[str, Any]:
        self._storage().update_draft(draft_id, updates, new_version)
        return self._storage().get_draft(draft_id)

    def find_by_message(self, channel: str, message_id: str) -> dict[str, Any] | None:
        return self._storage().find_draft_by_message(channel, message_id)

    def find_by_attachment(self, sha256: str) -> dict[str, Any] | None:
        return self._storage().find_draft_by_attachment(sha256)

    def find_by_normalized_hash(self, normalized_hash: str) -> dict[str, Any] | None:
        return self._storage().find_draft_by_normalized_hash(normalized_hash)

    def list_recent(self, limit: int = 50) -> list[dict[str, Any]]:
        s = self._storage()
        with s._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM drafts ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(row) for row in rows]


# Module-level singleton
drafts = DraftStorage()
