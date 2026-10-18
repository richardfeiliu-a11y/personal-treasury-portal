"""Audit log storage operations.

Delegates to the shared storage via get_storage() (lazy import to
avoid circular dependency with state.py). Accepts an optional explicit
storage for testing.
"""
from __future__ import annotations

from typing import Any


def _get_global_storage():
    from finance_bridge.app.state import get_storage
    return get_storage()


class AuditStorage:
    def __init__(self, storage=None):
        self._explicit = storage

    def _storage(self):
        return self._explicit if self._explicit is not None else _get_global_storage()

    def record(
        self,
        actor: str,
        action: str,
        object_type: str,
        object_id: int,
        old_values: dict[str, Any] | None = None,
        new_values: dict[str, Any] | None = None,
    ) -> int:
        return self._storage().record_audit(actor, action, object_type, object_id,
                                            old_values, new_values)

    def get_for_object(self, object_type: str, object_id: int) -> list[dict[str, Any]]:
        s = self._storage()
        with s._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM audit_events WHERE object_type = ? AND object_id = ? ORDER BY created_at",
                (object_type, object_id),
            ).fetchall()
            return [dict(row) for row in rows]

    def get_recent(self, limit: int = 100) -> list[dict[str, Any]]:
        s = self._storage()
        with s._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(row) for row in rows]


# Module-level singleton
audit = AuditStorage()
