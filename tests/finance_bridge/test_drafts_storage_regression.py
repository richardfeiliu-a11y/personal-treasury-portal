"""Regression tests for storage access in drafts API.

Original bug: drafts.py referenced `storage.create_idempotency_key` and
`storage.create_attachment_hash` at module level without defining `storage`,
causing a NameError on any POST /v1/drafts with attachment_sha256.

Fix (P1-2): Removed the duplicate module-level `_storage` from drafts.py.
Storage is now accessed via `get_storage()` imported from state.py, which
is initialized during the FastAPI lifespan.
"""
from __future__ import annotations

import finance_bridge.app.api.drafts as drafts_module
from finance_bridge.app.storage.sqlite import SQLiteStorage


def test_get_storage_imported():
    """drafts module must import get_storage from state."""
    assert hasattr(drafts_module, "get_storage"), "get_storage not imported in drafts module"
    assert callable(drafts_module.get_storage)


def test_get_storage_returns_storage_instance():
    """get_storage() should return a SQLiteStorage instance after init."""
    from finance_bridge.app.state import get_storage, reset_state
    reset_state()  # Initialize global storage with temp DB
    s = get_storage()
    assert s is not None
    assert isinstance(s, SQLiteStorage)


def test_no_module_level_storage_global():
    """The old module-level `storage` global must NOT exist (P1-2 removal)."""
    assert not hasattr(drafts_module, "storage"), (
        "drafts.py should not have a module-level 'storage' attribute; "
        "use get_storage() from state.py instead"
    )
