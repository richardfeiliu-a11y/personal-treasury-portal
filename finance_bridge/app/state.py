"""Application state and shared instances.

Storage lifecycle is managed via init_storage() / close_storage(),
called from the FastAPI lifespan handler.  Before init, get_storage()
raises RuntimeError to surface misconfiguration early.
"""
from __future__ import annotations

import os
import tempfile

from finance_bridge.app.config import Settings
from finance_bridge.app.storage.aliases import AliasStorage
from finance_bridge.app.storage.audit import AuditStorage
from finance_bridge.app.storage.drafts import DraftStorage
from finance_bridge.app.storage.sqlite import SQLiteStorage

settings = Settings()

_storage: SQLiteStorage | None = None
drafts = DraftStorage()
aliases = AliasStorage()
audit = AuditStorage()


def init_storage(database_url: str | None = None) -> SQLiteStorage:
    """Create (or recreate) the global SQLiteStorage instance.

    Called once during application startup (lifespan).
    """
    global _storage
    url = database_url or settings.bridge_database_url
    _storage = SQLiteStorage(url, settings)
    return _storage


def get_storage() -> SQLiteStorage:
    """Return the active storage instance. Raises if not initialised."""
    if _storage is None:
        raise RuntimeError(
            "Storage not initialised — ensure init_storage() is called "
            "during application startup (lifespan)."
        )
    return _storage


def close_storage() -> None:
    """Close the storage connection. Safe to call multiple times."""
    global _storage
    if _storage is not None:
        _storage.close()
        _storage = None


# ---------------------------------------------------------------------------
# Testing helpers
# ---------------------------------------------------------------------------

_temp_db_path: str | None = None


def reset_state():
    """Reset global state for testing. Creates a fresh temp-file database.

    Uses a temp file (not :memory:) because in-memory SQLite is per-connection,
    and the FastAPI async handler may use a different connection/thread.
    """
    global _storage, drafts, aliases, audit, _temp_db_path
    # Clean up previous temp file
    if _temp_db_path and os.path.exists(_temp_db_path):
        try:
            os.unlink(_temp_db_path)
        except Exception:
            pass
    fd, _temp_db_path = tempfile.mkstemp(suffix=".bridge-test.db")
    os.close(fd)
    _storage = SQLiteStorage(f"sqlite:///{_temp_db_path}", settings)
    drafts = DraftStorage()
    aliases = AliasStorage()
    audit = AuditStorage()
