"""SQLite storage layer for Finance Bridge.

Manages all Bridge control tables: drafts, attachment_hashes,
account_aliases, merchant_rules (DORMANT: table exists but unused, do not delete or build on),
fx_rates, and audit_events.

Schema is managed by the versioned migration engine (migrate.py).
"""
from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from finance_bridge.app.config import Settings
from finance_bridge.app.storage.errors import (
    ConflictError,
    NotFoundError,
    StaleVersionError,
    StorageError,
)

# Migrations directory: finance_bridge/migrations/
_MIGRATIONS_DIR = Path(__file__).resolve().parent.parent.parent / "migrations"


def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class SQLiteStorage:
    """Thread-safe SQLite storage with WAL mode."""

    def __init__(self, database_url: str, settings: Settings):
        self._db_path = self._extract_path(database_url)
        self._settings = settings
        self._local = threading.local()
        self._ensure_db()

    @staticmethod
    def _extract_path(database_url: str) -> str:
        """Extract file path from SQLite URL.

        实际使用的两种形式：`sqlite:///相对路径`（config 默认）与
        `sqlite:////绝对路径`（compose）。其余前缀防御不存在的配置，不保留。
        """
        if database_url.startswith("sqlite:///"):
            return database_url[10:]
        return database_url

    def _ensure_db(self) -> None:
        """Initialize database: set WAL mode, then run migration engine."""
        from finance_bridge.app.storage.migrate import initialize_schema

        db_file = Path(self._db_path)
        db_file.parent.mkdir(parents=True, exist_ok=True)

        with self._connection() as conn:
            # WAL is a file-level persistent setting; set once at init, not per-connection
            result = conn.execute("PRAGMA journal_mode = WAL").fetchone()[0]
            if result.lower() != "wal":
                raise StorageError(f"Failed to set WAL mode, got: {result}")
            conn.commit()

            # Run versioned migrations (adopt existing or create fresh)
            initialize_schema(conn, _MIGRATIONS_DIR)

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        """Thread-local connection context manager."""
        if not hasattr(self._local, "conn"):
            conn = sqlite3.connect(
                self._db_path,
                check_same_thread=False,
                isolation_level="DEFERRED",
            )
            conn.row_factory = sqlite3.Row
            # Connection-level PRAGMAs (must be set on every new connection)
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA busy_timeout = 5000")
            self._local.conn = conn
        try:
            yield self._local.conn
        except Exception:
            self._local.conn.rollback()
            raise

    def close(self) -> None:
        """Close the database connection."""
        if hasattr(self._local, "conn"):
            try:
                self._local.conn.close()
            except Exception:
                pass
            delattr(self._local, "conn")

    # --- Draft operations ---

    def create_draft(self, data: dict[str, Any]) -> int:
        """Create a new draft. Returns draft ID.

        Raises ConflictError if duplicate channel+message_id.
        """
        with self._connection() as conn:
            try:
                cursor = conn.execute("""
                    INSERT INTO drafts (
                        channel, source_message_id, attachment_sha256,
                        occurred_at, amount, currency, transaction_intent,
                        source_account_alias, destination_account_alias,
                        description, merchant, fx_rate, foreign_amount, foreign_currency,
                        fx_rate_date, fx_rate_source, confidence, status, draft_version,
                        normalized_hash, clarification_message
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    data["channel"],
                    data["source_message_id"],
                    data.get("attachment_sha256"),
                    data["occurred_at"],
                    str(data["amount"]),
                    data["currency"].upper(),
                    data["transaction_intent"],
                    data["source_account_alias"],
                    data["destination_account_alias"],
                    data.get("description"),
                    data.get("merchant"),
                    data.get("fx_rate"),
                    data.get("foreign_amount"),
                    data.get("foreign_currency"),
                    data.get("fx_rate_date"),
                    data.get("fx_rate_source"),
                    data.get("confidence"),
                    data.get("status", "received"),
                    data.get("draft_version", 1),
                    data.get("normalized_hash"),
                    data.get("clarification_message"),
                ))
                draft_id = cursor.lastrowid
                conn.commit()
                return draft_id
            except sqlite3.IntegrityError as e:
                conn.rollback()
                raise ConflictError(f"Duplicate draft: {e}")

    def get_draft(self, draft_id: int) -> dict[str, Any]:
        """Get a draft by ID."""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM drafts WHERE id = ?", (draft_id,)
            ).fetchone()
            if not row:
                raise NotFoundError(f"Draft {draft_id} not found")
            return dict(row)

    def update_draft_status(self, draft_id: int, status: str, draft_version: int) -> int:
        """Update draft status with optimistic locking.

        The WHERE clause verifies the expected draft_version to prevent
        concurrent conflicting updates.  If rowcount == 0 it means either
        the draft was deleted or another writer already advanced the version.
        """
        with self._connection() as conn:
            cur = conn.execute("""
                UPDATE drafts
                SET status = ?, draft_version = ?, updated_at = ?
                WHERE id = ? AND draft_version = ?
            """, (status, draft_version + 1, _now_utc(), draft_id, draft_version))
            if cur.rowcount == 0:
                conn.rollback()
                raise StaleVersionError(
                    f"Stale version conflict: draft {draft_id} version {draft_version} "
                    f"no longer current (concurrent update or draft not found)"
                )
            conn.commit()
        return draft_version + 1

    def update_draft_posted(self, draft_id: int, journal_id: str, draft_version: int) -> int:
        """Mark draft posted with Firefly journal id, optimistic-lock guarded."""
        with self._connection() as conn:
            cur = conn.execute("""
                UPDATE drafts
                SET status = ?, firefly_transaction_id = ?, draft_version = ?, updated_at = ?
                WHERE id = ? AND draft_version = ?
            """, ("posted", str(journal_id), draft_version + 1,
                  _now_utc(), draft_id, draft_version))
            if cur.rowcount == 0:
                conn.rollback()
                raise StaleVersionError(
                    f"Draft {draft_id}: expected version {draft_version} no longer current"
                )
            conn.commit()
        return draft_version + 1

    def update_draft(self, draft_id: int, updates: dict[str, Any], new_version: int) -> None:
        """Update draft fields and increment version."""
        set_clauses = ["draft_version = ?", "updated_at = ?"]
        values = [new_version, _now_utc()]

        for key, value in updates.items():
            if key in ("description", "merchant", "fx_rate", "foreign_amount", "foreign_currency",
                       "fx_rate_date", "fx_rate_source", "amount", "currency",
                       "occurred_at", "source_account_alias", "destination_account_alias",
                       "status", "clarification_message", "normalized_hash"):
                set_clauses.append(f"{key} = ?")
                values.append(value)

        values.append(draft_id)

        with self._connection() as conn:
            conn.execute(
                f"UPDATE drafts SET {', '.join(set_clauses)} WHERE id = ?",
                values,
            )
            conn.commit()

    def find_draft_by_message(self, channel: str, message_id: str) -> dict[str, Any] | None:
        """Find existing draft by channel + message ID."""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM drafts WHERE channel = ? AND source_message_id = ?",
                (channel, message_id),
            ).fetchone()
            return dict(row) if row else None

    def find_draft_by_attachment(self, sha256: str) -> dict[str, Any] | None:
        """Find existing draft by attachment hash."""
        with self._connection() as conn:
            row = conn.execute(
                """SELECT d.* FROM drafts d
                   JOIN attachment_hashes ah ON ah.draft_id = d.id
                   WHERE ah.sha256 = ?""",
                (sha256,),
            ).fetchone()
            return dict(row) if row else None

    def find_draft_by_normalized_hash(self, normalized_hash: str) -> dict[str, Any] | None:
        """Find existing draft by normalized transaction hash."""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM drafts WHERE normalized_hash = ?",
                (normalized_hash,),
            ).fetchone()
            return dict(row) if row else None

    # --- Attachment hash operations ---

    def create_attachment_hash(self, sha256: str, draft_id: int, channel: str) -> None:
        """Record an attachment hash."""
        with self._connection() as conn:
            try:
                conn.execute(
                    "INSERT INTO attachment_hashes (sha256, draft_id, channel) VALUES (?, ?, ?)",
                    (sha256, draft_id, channel),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                conn.rollback()

    # --- Account alias operations ---

    def create_alias(self, alias: str, account_type: str, currency: str,
                     firefly_account_id: int | None = None) -> int:
        """Create an account alias."""
        with self._connection() as conn:
            try:
                cursor = conn.execute(
                    """INSERT INTO account_aliases (alias, account_type, currency, firefly_account_id)
                       VALUES (?, ?, ?, ?)""",
                    (alias.strip(), account_type, currency.upper(), firefly_account_id),
                )
                conn.commit()
                return cursor.lastrowid
            except sqlite3.IntegrityError:
                conn.rollback()
                raise ConflictError(f"Alias '{alias}' already exists")

    def get_alias(self, alias: str) -> dict[str, Any] | None:
        """Get alias by name."""
        with self._connection() as conn:
            row = conn.execute(
                "SELECT * FROM account_aliases WHERE alias = ? AND is_active = 1",
                (alias.strip(),),
            ).fetchone()
            return dict(row) if row else None

    def list_aliases(self, include_inactive: bool = False) -> list[dict[str, Any]]:
        """List all aliases, optionally including inactive ones."""
        with self._connection() as conn:
            if include_inactive:
                rows = conn.execute(
                    "SELECT * FROM account_aliases ORDER BY is_active DESC, alias"
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM account_aliases WHERE is_active = 1 ORDER BY alias"
                ).fetchall()
            return [dict(row) for row in rows]

    def upsert_alias_fail_closed(
        self, alias: str, account_type: str, currency: str,
        firefly_account_id: int | None = None,
    ) -> tuple[int, str]:
        """Insert or update an alias with fail-closed semantics.

        Returns (alias_id, action) where action is one of:
          'created'  — new alias inserted
          'matched'  — existing alias is identical (idempotent success)
          'conflict' — alias exists but fields differ; NOT modified

        Raises ConflictError when existing alias has different
        firefly_account_id, account_type, or currency — never
        silently overwrites.
        Only 'matched' (everything identical) counts as success
        without raising.
        """
        with self._connection() as conn:
            existing = conn.execute(
                "SELECT * FROM account_aliases WHERE alias = ?", (alias.strip(),)
            ).fetchone()
            if existing:
                existing = dict(existing)
                # Check for conflicts that must NOT be silently overwritten
                conflicts = []
                if existing["firefly_account_id"] != firefly_account_id:
                    conflicts.append(
                        f"firefly_account_id differs: existing={existing['firefly_account_id']} "
                        f"new={firefly_account_id}"
                    )
                if existing["account_type"] != account_type:
                    conflicts.append(
                        f"account_type differs: existing={existing['account_type']} new={account_type}"
                    )
                if existing["currency"].upper() != currency.upper():
                    conflicts.append(
                        f"currency differs: existing={existing['currency']} new={currency}"
                    )
                if conflicts:
                    raise ConflictError(
                        f"Alias '{alias}' already exists with different fields: "
                        + "; ".join(conflicts)
                    )
                # Everything matched — idempotent success
                if existing["is_active"] != 1:
                    # Reactivate if deactivated
                    conn.execute(
                        "UPDATE account_aliases SET is_active = 1 WHERE id = ?",
                        (existing["id"],),
                    )
                    conn.commit()
                return existing["id"], "matched"
            # Create new
            cursor = conn.execute(
                """INSERT INTO account_aliases (alias, account_type, currency, firefly_account_id)
                   VALUES (?, ?, ?, ?)""",
                (alias.strip(), account_type, currency.upper(), firefly_account_id),
            )
            conn.commit()
            return cursor.lastrowid, "created"

    def deactivate_alias(self, alias: str) -> bool:
        """Deactivate an alias. Returns True if found and deactivated."""
        with self._connection() as conn:
            cursor = conn.execute(
                "UPDATE account_aliases SET is_active = 0 WHERE alias = ? AND is_active = 1",
                (alias.strip(),),
            )
            conn.commit()
            return cursor.rowcount > 0

    def find_aliases_by_firefly_id(self, firefly_account_id: int) -> list[dict[str, Any]]:
        """Find all aliases pointing to a given Firefly account ID."""
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM account_aliases WHERE firefly_account_id = ? ORDER BY is_active DESC",
                (firefly_account_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    # --- Audit operations ---

    def record_audit(
        self,
        actor: str,
        action: str,
        object_type: str,
        object_id: int,
        old_values: dict | None = None,
        new_values: dict | None = None,
    ) -> int:
        """Record an audit event."""
        import json
        with self._connection() as conn:
            cursor = conn.execute(
                """INSERT INTO audit_events (actor, action, object_type, object_id, old_values, new_values)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    actor,
                    action,
                    object_type,
                    object_id,
                    json.dumps(old_values, default=str) if old_values else None,
                    json.dumps(new_values, default=str) if new_values else None,
                ),
            )
            conn.commit()
            return cursor.lastrowid
