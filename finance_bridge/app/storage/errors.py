"""Storage error definitions for Finance Bridge."""
from __future__ import annotations


class StorageError(Exception):
    """Base storage error."""


class NotFoundError(StorageError):
    """Record not found."""


class ConflictError(StorageError):
    """Duplicate or conflicting record."""


class StaleVersionError(StorageError):
    """Optimistic-lock version check failed (concurrent update or stale version)."""
