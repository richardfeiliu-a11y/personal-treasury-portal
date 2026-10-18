"""Firefly III API client.

Encapsulates all HTTP communication with Firefly.
Does NOT allow LLM to call this directly.
"""
from __future__ import annotations

from typing import Any

import httpx
from finance_bridge.app.config import Settings
from finance_bridge.app.firefly.errors import (
    FireflyAuthError,
    FireflyError,
    FireflyNotFoundError,
    FireflyServerError,
    FireflyTimeoutError,
    FireflyValidationError,
)
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

# Retryable errors
_RETRYABLE = (FireflyServerError, FireflyTimeoutError)


class FireflyClient:
    """HTTP client for Firefly III API."""

    def __init__(self, settings: Settings):
        self._settings = settings
        self._client = httpx.Client(
            base_url=settings.firefly_api_url,
            headers={
                "Authorization": f"Bearer {settings.firefly_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            timeout=httpx.Timeout(30.0, connect=10.0),
        )

    @property
    def is_configured(self) -> bool:
        return self._settings.has_firefly_credentials

    def list_accounts(self) -> list[dict[str, Any]]:
        """List all accounts."""
        response = self._get("/accounts")
        return response.get("data", [])

    def get_account(self, account_id: int) -> dict[str, Any]:
        """Get a specific account."""
        response = self._get(f"/accounts/{account_id}")
        return response.get("data", {})

    def create_transaction(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Create a transaction. Returns the created transaction."""
        response = self._post("/transactions", {"transactions": [payload]})
        data = response.get("data", {})
        # Firefly v6 returns data as an object for single transaction creation
        if isinstance(data, dict):
            return data
        # Fallback for list response (some API combinations)
        return data[0] if data else {}

    def get_transaction(self, transaction_id: int) -> dict[str, Any]:
        """Get a transaction by ID."""
        response = self._get(f"/transactions/{transaction_id}")
        return response.get("data", {})

    def get_transaction_by_external_id(self, external_id: str) -> dict[str, Any] | None:
        """Find transaction by external reference (our draft ID).

        Firefly's /search/transactions endpoint filters through the ``query``
        parameter using operator syntax. The exact-match operator for external
        IDs is ``external_id_is``; a bare top-level ``external_id`` query param
        is not a search filter and would be ignored, silently returning no match
        and defeating the idempotency recovery path.
        """
        params = {"query": f"external_id_is:{external_id}"}
        response = self._get("/search/transactions", params=params)
        data = response.get("data", [])
        return data[0] if data else None

    def get_account_balances(
        self,
        account_types: list[str] | None = None,
        date: str | None = None,
        include_net_worth_only: bool = False,
    ) -> list[dict[str, Any]]:
        """Get all accounts with balances, with full pagination.

        When ``date`` (YYYY-MM-DD) is given, Firefly returns each account's
        balance as of that date — required for historical balance sheets.
        Iterates all pages to guarantee complete data.
        Raises on any API error — never silently returns partial data.

        When ``include_net_worth_only=True``, accounts marked
        ``include_net_worth=false`` in Firefly (e.g. migration-settlement
        accounts) are filtered out — use this for any net-worth valuation
        (net-worth, currency exposure, FX attribution, balance
        sheet, net-worth trend). Keep the default False for views that need
        the full account list (account page, health checks).
        """
        if account_types is None:
            account_types = ["asset", "liabilities", "expense", "revenue"]

        date_param = f"&date={date}" if date else ""
        results: list[dict[str, Any]] = []
        for atype in account_types:
            page = 1
            while True:
                resp = self._get(f"/accounts?type={atype}&page={page}&limit=50{date_param}")
                data = resp.get("data", [])
                if not data:
                    break
                results.extend(data)
                meta = resp.get("meta", {})
                pag = meta.get("pagination", {})
                total_pages = pag.get("total_pages", 0)
                if page >= total_pages:
                    break
                page += 1
        if include_net_worth_only:
            results = [
                acct for acct in results
                if bool((acct.get("attributes") or {}).get("include_net_worth", True))
            ]
        return results

    def get_transactions_in_range(
        self, start_date: str, end_date: str,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Get all transactions in a date range, with pagination."""
        results: list[dict[str, Any]] = []
        page = 1
        while True:
            resp = self._get(
                f"/transactions?start={start_date}&end={end_date}"
                f"&page={page}&limit=50"
            )
            data = resp.get("data", [])
            if not data:
                break
            results.extend(data)
            meta = resp.get("meta", {})
            pag = meta.get("pagination", {})
            total_pages = pag.get("total_pages", 0)
            if page >= total_pages:
                break
            page += 1
        return results

    @retry(
        retry=retry_if_exception_type(_RETRYABLE),
        wait=wait_exponential(multiplier=0.5, min=1, max=3),
        stop=stop_after_attempt(2),
        reraise=True,
    )
    def _get(self, path: str, **kwargs: Any) -> dict[str, Any]:
        try:
            response = self._client.get(path, **kwargs)
            response.raise_for_status()
            return response.json()
        except httpx.TimeoutException:
            raise FireflyTimeoutError(f"GET {path} timed out")
        except httpx.HTTPStatusError as e:
            self._raise_for_status(e)

    def _post(self, path: str, json: dict[str, Any]) -> dict[str, Any]:
        try:
            response = self._client.post(path, json=json)
            response.raise_for_status()
            return response.json()
        except httpx.TimeoutException:
            raise FireflyTimeoutError(f"POST {path} timed out")
        except httpx.HTTPStatusError as e:
            self._raise_for_status(e)

    def _raise_for_status(self, error: httpx.HTTPStatusError) -> None:
        status = error.response.status_code
        if status == 401:
            raise FireflyAuthError("Firefly authentication failed", status)
        elif status == 404:
            raise FireflyNotFoundError(f"Resource not found: {error.request.url}", status)
        elif status == 422:
            raise FireflyValidationError(f"Validation error: {error.response.text}", status)
        elif status >= 500:
            raise FireflyServerError(f"Firefly server error: {status}", status)
        else:
            raise FireflyError(f"HTTP {status}: {error.response.text}", status)

    def close(self) -> None:
        """Close the HTTP client."""
        self._client.close()

    def __enter__(self) -> FireflyClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
