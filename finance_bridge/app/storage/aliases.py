"""Alias-specific storage operations.

Delegates to the shared storage via get_storage() (lazy import to
avoid circular dependency with state.py). Accepts an optional explicit
storage for testing.
"""
from __future__ import annotations

from typing import Any


def _get_global_storage():
    from finance_bridge.app.state import get_storage
    return get_storage()


class AliasStorage:
    """Alias-specific operations on top of SQLiteStorage."""

    def __init__(self, storage=None):
        self._explicit = storage

    def _storage(self):
        return self._explicit if self._explicit is not None else _get_global_storage()

    def create(self, alias: str, account_type: str, currency: str,
               firefly_account_id: int | None = None) -> int:
        return self._storage().create_alias(alias, account_type, currency, firefly_account_id)

    def get(self, alias: str) -> dict[str, Any] | None:
        return self._storage().get_alias(alias)

    def list_all(self, include_inactive: bool = False) -> list[dict[str, Any]]:
        return self._storage().list_aliases(include_inactive)

    def exists(self, alias: str) -> bool:
        return self._storage().get_alias(alias) is not None

    def upsert_safe(self, alias: str, account_type: str, currency: str,
                    firefly_account_id: int | None = None) -> tuple[int, str]:
        """Fail-closed upsert. Raises ConflictError on field mismatch."""
        return self._storage().upsert_alias_fail_closed(alias, account_type, currency, firefly_account_id)

    def deactivate(self, alias: str) -> bool:
        return self._storage().deactivate_alias(alias)

    def find_by_firefly_id(self, firefly_account_id: int) -> list[dict[str, Any]]:
        return self._storage().find_aliases_by_firefly_id(firefly_account_id)


# Module-level singleton
aliases = AliasStorage()
