"""Firefly III API error types."""
from __future__ import annotations


class FireflyError(Exception):
    """Base Firefly API error."""
    def __init__(self, message: str, status_code: int | None = None):
        self.status_code = status_code
        super().__init__(message)


class FireflyAuthError(FireflyError):
    """Authentication failed (401)."""


class FireflyNotFoundError(FireflyError):
    """Resource not found (404)."""


class FireflyValidationError(FireflyError):
    """Request validation failed (422)."""


class FireflyServerError(FireflyError):
    """Server error (5xx)."""


class FireflyTimeoutError(FireflyError):
    """Request timed out."""
