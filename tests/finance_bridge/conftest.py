"""Shared pytest fixtures for Finance Bridge tests."""
from __future__ import annotations

import os
import tempfile

import pytest

from finance_bridge.app.config import Settings
from finance_bridge.app.storage.sqlite import SQLiteStorage


@pytest.fixture
def temp_db():
    """Create a temporary SQLite database for testing."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    settings = Settings(bridge_database_url=f"sqlite:///{path}")
    storage = SQLiteStorage(f"sqlite:///{path}", settings)
    yield storage
    storage.close()
    os.unlink(path)


@pytest.fixture
def temp_storage(temp_db):
    """Alias for temp_db for use in domain tests."""
    return temp_db


@pytest.fixture
def mock_settings():
    """Settings with a mock Firefly URL and token (for client tests)."""
    from finance_bridge.app.config import Settings
    return Settings(
        firefly_api_url="http://localhost:18080/api/v1",
        firefly_token="test-token-123",
    )
