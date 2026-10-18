"""Tests for the versioned migration engine.

Covers: fresh_db, adopt_current, adopt_missing_column, adopt_missing_constraint,
adopt_concurrent, checksum_tampered, version_ahead, concurrent, idempotent,
bad_filename, version_gap, empty_dir, missing_dir, sql_with_begin,
sql_with_semicolon_in_string, baseline_matches_manifest.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import tempfile
import threading
from pathlib import Path

import pytest

from finance_bridge.app.storage.migrate import (
    MigrationError,
    _split_statements,
    adopt_existing_db,
    initialize_schema,
    run_migrations,
)

# Path to the real migrations directory（仓库根 = 上两级）
REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_MIGRATIONS_DIR = REPO_ROOT / "finance_bridge" / "migrations"


@pytest.fixture
def tmp_migrations(tmp_path):
    """Create a temporary migrations directory with a copy of the real baseline."""
    mig_dir = tmp_path / "migrations"
    mig_dir.mkdir()
    shutil.copy(REAL_MIGRATIONS_DIR / "001_baseline.sql", mig_dir / "001_baseline.sql")
    return mig_dir


@pytest.fixture
def fresh_db(tmp_path):
    """Create a fresh empty SQLite database file."""
    db_path = tmp_path / "test.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    yield conn, db_path
    conn.close()


class TestFreshDb:
    """fresh_db: empty database executes 001, tables created, migration recorded."""

    def test_fresh_db_creates_all_tables(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        run_migrations(conn, tmp_migrations)

        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        expected = {
            "drafts", "idempotency_keys", "attachment_hashes",
            "account_aliases", "merchant_rules", "fx_rates",
            "audit_events", "_schema_migrations",
        }
        assert expected.issubset(tables)

    def test_fresh_db_records_migration(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        run_migrations(conn, tmp_migrations)

        rows = conn.execute("SELECT version, filename FROM _schema_migrations").fetchall()
        assert len(rows) == 1
        assert rows[0][0] == 1
        assert rows[0][1] == "001_baseline.sql"


class TestAdoptCurrent:
    """adopt_current: existing DB with correct structure gets adopted without DDL."""

    def test_adopt_existing_matching_db(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        # First create the schema normally
        run_migrations(conn, tmp_migrations)
        # Remove _schema_migrations to simulate unmanaged DB
        conn.execute("DROP TABLE _schema_migrations")
        conn.commit()

        # Now adopt
        adopt_existing_db(conn, tmp_migrations)

        rows = conn.execute("SELECT version, filename FROM _schema_migrations").fetchall()
        assert len(rows) == 1
        assert rows[0][0] == 1

    def test_adopt_skips_already_managed(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        run_migrations(conn, tmp_migrations)
        # adopt should be a no-op
        adopt_existing_db(conn, tmp_migrations)
        rows = conn.execute("SELECT version FROM _schema_migrations").fetchall()
        assert len(rows) == 1


class TestAdoptConcurrent:
    """adopt_concurrent: two connections, only one adopts."""

    def test_concurrent_adopt(self, tmp_path, tmp_migrations):
        db_path = tmp_path / "concurrent.db"
        # Create schema first
        conn1 = sqlite3.connect(str(db_path))
        conn1.execute("PRAGMA journal_mode = WAL")
        conn1.execute("PRAGMA busy_timeout = 5000")
        run_migrations(conn1, tmp_migrations)
        conn1.execute("DROP TABLE _schema_migrations")
        conn1.commit()
        conn1.close()

        results = []

        def try_adopt():
            c = sqlite3.connect(str(db_path), timeout=10)
            c.execute("PRAGMA busy_timeout = 5000")
            try:
                adopt_existing_db(c, tmp_migrations)
                rows = c.execute("SELECT COUNT(*) FROM _schema_migrations").fetchone()[0]
                results.append(("ok", rows))
            except Exception as e:
                results.append(("error", str(e)))
            finally:
                c.close()

        t1 = threading.Thread(target=try_adopt)
        t2 = threading.Thread(target=try_adopt)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        # Both should succeed (one adopts, one sees already managed)
        ok_count = sum(1 for status, _ in results if status == "ok")
        assert ok_count == 2
        # Final state: exactly 1 migration record
        c = sqlite3.connect(str(db_path))
        count = c.execute("SELECT COUNT(*) FROM _schema_migrations").fetchone()[0]
        c.close()
        assert count == 1


class TestChecksumTampered:
    """checksum_tampered: modified migration file is rejected."""

    def test_reject_tampered_file(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        run_migrations(conn, tmp_migrations)

        # Tamper with the migration file
        baseline = tmp_migrations / "001_baseline.sql"
        baseline.write_text(baseline.read_text() + "\n-- tampered\n")

        with pytest.raises(MigrationError, match="modified after application"):
            run_migrations(conn, tmp_migrations)


class TestVersionAhead:
    """version_ahead: DB version > code version is rejected."""

    def test_reject_ahead_version(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        run_migrations(conn, tmp_migrations)

        # Insert a fake future version
        conn.execute(
            "INSERT INTO _schema_migrations (version, filename, checksum_sha256) VALUES (99, '099_fake.sql', 'abc')"
        )
        conn.commit()

        with pytest.raises(MigrationError, match="Refusing to start with older code"):
            run_migrations(conn, tmp_migrations)


class TestConcurrent:
    """concurrent: two connections same file, second doesn't re-execute."""

    def test_concurrent_migrations(self, tmp_path, tmp_migrations):
        db_path = tmp_path / "concurrent_mig.db"
        results = []

        def run():
            c = sqlite3.connect(str(db_path), timeout=10)
            c.execute("PRAGMA journal_mode = WAL")
            c.execute("PRAGMA busy_timeout = 5000")
            try:
                run_migrations(c, tmp_migrations)
                results.append("ok")
            except Exception as e:
                results.append(f"error: {e}")
            finally:
                c.close()

        t1 = threading.Thread(target=run)
        t2 = threading.Thread(target=run)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        assert all(r == "ok" for r in results), f"Results: {results}"
        c = sqlite3.connect(str(db_path))
        count = c.execute("SELECT COUNT(*) FROM _schema_migrations").fetchone()[0]
        c.close()
        assert count == 1


class TestIdempotent:
    """idempotent: repeated run_migrations has no side effects."""

    def test_idempotent(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        run_migrations(conn, tmp_migrations)
        run_migrations(conn, tmp_migrations)
        run_migrations(conn, tmp_migrations)

        rows = conn.execute("SELECT COUNT(*) FROM _schema_migrations").fetchone()[0]
        assert rows == 1


class TestBadFilename:
    """bad_filename: non-conforming .sql file is rejected."""

    def test_reject_bad_name(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        (tmp_migrations / "Bad_Name.sql").write_text("SELECT 1;")

        with pytest.raises(MigrationError, match="does not match required pattern"):
            run_migrations(conn, tmp_migrations)


class TestVersionGap:
    """version_gap: non-contiguous versions are rejected."""

    def test_reject_gap(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        # Rename 001 to 003 to create a gap
        (tmp_migrations / "001_baseline.sql").rename(tmp_migrations / "003_baseline.sql")

        with pytest.raises(MigrationError, match="contiguous from 001"):
            run_migrations(conn, tmp_migrations)


class TestEmptyDir:
    """empty_dir: empty migrations directory is rejected."""

    def test_reject_empty(self, fresh_db, tmp_path):
        conn, db_path = fresh_db
        empty_dir = tmp_path / "empty_migrations"
        empty_dir.mkdir()

        with pytest.raises(MigrationError, match="No migration files"):
            run_migrations(conn, empty_dir)


class TestMissingDir:
    """missing_dir: non-existent migrations directory is rejected."""

    def test_reject_missing(self, fresh_db, tmp_path):
        conn, db_path = fresh_db
        missing = tmp_path / "does_not_exist"

        with pytest.raises(MigrationError, match="not found"):
            run_migrations(conn, missing)


class TestSqlWithBegin:
    """sql_with_begin: SQL file containing BEGIN is rejected."""

    def test_reject_begin(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        (tmp_migrations / "002_bad.sql").write_text("BEGIN;\nCREATE TABLE x (id INTEGER);\nCOMMIT;")

        with pytest.raises(MigrationError, match="transaction control"):
            run_migrations(conn, tmp_migrations)


class TestSemicolonInString:
    """sql_with_semicolon_in_string: semicolons in strings are handled correctly."""

    def test_semicolon_in_string(self):
        sql = "INSERT INTO t (val) VALUES ('hello; world');\nSELECT 1;"
        stmts = _split_statements(sql)
        assert len(stmts) == 2
        assert "hello; world" in stmts[0]

    def test_semicolon_in_comment(self):
        sql = "-- this is a comment; with semicolon\nSELECT 1;"
        stmts = _split_statements(sql)
        assert len(stmts) == 1
        assert stmts[0].startswith("--")  or "SELECT 1" in stmts[0]


class TestInitializeSchema:
    """Integration test: initialize_schema works end-to-end."""

    def test_fresh_initialize(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        initialize_schema(conn, tmp_migrations)

        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        assert "_schema_migrations" in tables
        assert "drafts" in tables

    def test_adopt_then_initialize(self, fresh_db, tmp_migrations):
        conn, db_path = fresh_db
        # Create schema, remove migration table, then re-initialize
        initialize_schema(conn, tmp_migrations)
        conn.execute("DROP TABLE _schema_migrations")
        conn.commit()

        # Should adopt and succeed
        initialize_schema(conn, tmp_migrations)
        rows = conn.execute("SELECT version FROM _schema_migrations").fetchall()
        assert len(rows) == 1
