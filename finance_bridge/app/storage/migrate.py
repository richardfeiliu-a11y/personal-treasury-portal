"""Versioned schema migration engine for Finance Bridge.

Design principles:
- 001_baseline.sql is the single source of truth for schema structure.
- Every migration is atomic: DDL + version recording in one BEGIN IMMEDIATE...COMMIT.
- Fail closed: any error blocks Bridge startup.
- Applied migration files are immutable (checksum verified).
- Migration SQL must not contain BEGIN/COMMIT/ROLLBACK (engine manages transactions).
"""
from __future__ import annotations

import hashlib
import re
import sqlite3
from pathlib import Path

MIGRATION_PATTERN = re.compile(r"^(\d{3})_[a-z0-9_]+\.sql$")

_TX_CONTROL = re.compile(
    r"^\s*(BEGIN|COMMIT|ROLLBACK|END\s+TRANSACTION)\b", re.IGNORECASE
)


class MigrationError(Exception):
    """Blocks application startup."""


# ---------------------------------------------------------------------------
# SQL statement parsing
# ---------------------------------------------------------------------------


def _is_pure_comment(stmt: str) -> bool:
    """Check if a statement is only comments/whitespace."""
    stripped = re.sub(r"--[^\n]*", "", stmt)
    stripped = re.sub(r"/\*.*?\*/", "", stripped, flags=re.DOTALL)
    return not stripped.strip().rstrip(";").strip()


def _split_statements(sql_text: str) -> list[str]:
    """Split SQL text into individual statements using sqlite3.complete_statement().

    Correctly handles semicolons inside strings, comments, and triggers.
    """
    statements: list[str] = []
    buffer = ""
    for line in sql_text.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            stmt = buffer.strip()
            if stmt and not _is_pure_comment(stmt):
                statements.append(stmt)
            buffer = ""
    if buffer.strip() and not _is_pure_comment(buffer.strip()):
        raise MigrationError(
            f"Incomplete SQL statement at end of file: {buffer[:80]}..."
        )
    return statements


def _validate_statements(statements: list[str], filename: str) -> None:
    """Reject transaction control statements (checked per-statement, not raw text)."""
    for stmt in statements:
        if _TX_CONTROL.match(stmt):
            raise MigrationError(
                f"Migration {filename} contains transaction control: "
                f"'{stmt[:60]}...'. Transaction is managed by the engine."
            )


# ---------------------------------------------------------------------------
# Migration discovery
# ---------------------------------------------------------------------------


def _discover_migrations(migrations_dir: Path) -> list[tuple[int, Path]]:
    """Discover, validate naming, reject gaps and duplicates."""
    if not migrations_dir.is_dir():
        raise MigrationError(f"Migrations directory not found: {migrations_dir}")
    files: list[tuple[int, Path]] = []
    for f in sorted(migrations_dir.iterdir()):
        if f.suffix != ".sql":
            continue
        m = MIGRATION_PATTERN.match(f.name)
        if not m:
            raise MigrationError(
                f"Migration file '{f.name}' does not match required pattern "
                f"NNN_lowercase_name.sql"
            )
        files.append((int(m.group(1)), f))
    if not files:
        raise MigrationError(f"No migration files in {migrations_dir}")
    versions = [v for v, _ in files]
    if len(versions) != len(set(versions)):
        raise MigrationError("Duplicate migration version numbers")
    expected = list(range(1, len(versions) + 1))
    if versions != expected:
        raise MigrationError(
            f"Migration versions must be contiguous from 001. Got: {versions}"
        )
    return files


# ---------------------------------------------------------------------------
# Schema extraction and comparison
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Adopt existing production database
# ---------------------------------------------------------------------------


def adopt_existing_db(conn: sqlite3.Connection, migrations_dir: Path) -> None:
    """Adopt an existing production DB under migration management.

    Uses BEGIN IMMEDIATE to prevent concurrent adopt races.
    A28 消融：原全量结构 diff（_extract_full_schema/_compare_schemas，约 120 行）
    仅服务于一次性 adopt 过渡；生产库已于 004 时代 adopt（_schema_migrations
    存在），新建库走空表 early-return，未托管带表库不再可能出现。此处直接
    记录 baseline，不做结构校验。
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        # Re-check under lock: another process may have adopted already
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        if not tables:
            conn.rollback()
            return  # Fresh DB, normal migration path
        if "_schema_migrations" in tables:
            conn.rollback()
            return  # Already managed

        # Adopt: create migration table and record baseline
        baseline = migrations_dir / "001_baseline.sql"
        file_hash = hashlib.sha256(baseline.read_bytes()).hexdigest()
        conn.execute(
            """CREATE TABLE _schema_migrations (
                version INTEGER PRIMARY KEY,
                filename TEXT NOT NULL UNIQUE,
                checksum_sha256 TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            )"""
        )
        conn.execute(
            "INSERT INTO _schema_migrations (version, filename, checksum_sha256) "
            "VALUES (1,?,?)",
            ("001_baseline.sql", file_hash),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


# ---------------------------------------------------------------------------
# Main migration runner
# ---------------------------------------------------------------------------


def run_migrations(conn: sqlite3.Connection, migrations_dir: Path) -> None:
    """Run all pending migrations atomically.

    Must be called after adopt_existing_db() (which handles the unmanaged case).
    """
    files = _discover_migrations(migrations_dir)
    max_code_version = files[-1][0]

    # Ensure migration table exists (outside main transaction)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS _schema_migrations (
            version INTEGER PRIMARY KEY,
            filename TEXT NOT NULL UNIQUE,
            checksum_sha256 TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        )"""
    )
    conn.commit()

    # --- Acquire write lock BEFORE reading applied state ---
    conn.execute("BEGIN IMMEDIATE")
    try:
        applied = {
            r[0]: (r[1], r[2])
            for r in conn.execute(
                "SELECT version, filename, checksum_sha256 FROM _schema_migrations"
            )
        }

        # Reject: DB version ahead of code
        if applied and max(applied) > max_code_version:
            raise MigrationError(
                f"Database schema version {max(applied)} > code version "
                f"{max_code_version}. Refusing to start with older code."
            )

        # Verify checksums of already-applied migrations
        for version, (filename, stored_hash) in applied.items():
            fpath = migrations_dir / filename
            if not fpath.exists():
                raise MigrationError(f"Applied migration file missing: {filename}")
            actual = hashlib.sha256(fpath.read_bytes()).hexdigest()
            if actual != stored_hash:
                raise MigrationError(
                    f"Migration {filename} modified after application. "
                    f"Expected {stored_hash[:16]}..., got {actual[:16]}..."
                )

        # Apply pending migrations
        for version, fpath in files:
            if version in applied:
                continue
            sql_text = fpath.read_text(encoding="utf-8")
            statements = _split_statements(sql_text)
            _validate_statements(statements, fpath.name)
            file_hash = hashlib.sha256(fpath.read_bytes()).hexdigest()
            # Execute DDL within the same IMMEDIATE transaction
            for statement in statements:
                conn.execute(statement)
            conn.execute(
                "INSERT INTO _schema_migrations (version, filename, checksum_sha256) "
                "VALUES (?,?,?)",
                (version, fpath.name, file_hash),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def initialize_schema(conn: sqlite3.Connection, migrations_dir: Path) -> None:
    """Full initialization: adopt if needed, then run migrations.

    This is the single entry point called from SQLiteStorage._ensure_db().
    """
    adopt_existing_db(conn, migrations_dir)
    run_migrations(conn, migrations_dir)
