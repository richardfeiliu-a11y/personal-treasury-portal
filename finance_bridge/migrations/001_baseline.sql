-- 001_baseline.sql
-- Complete schema for Finance Bridge as of 2026-07-26.
-- This is the single source of truth for the database structure.
-- No PRAGMA statements (connection-level settings are handled by the app).
-- No BEGIN/COMMIT (transaction control is managed by the migration engine).

CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    attachment_sha256 TEXT,
    occurred_at TEXT NOT NULL,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    transaction_intent TEXT NOT NULL,
    source_account_alias TEXT NOT NULL,
    destination_account_alias TEXT NOT NULL,
    description TEXT,
    merchant TEXT,
    fx_rate TEXT,
    confidence REAL,
    status TEXT NOT NULL DEFAULT 'received',
    draft_version INTEGER NOT NULL DEFAULT 1,
    normalized_hash TEXT,
    clarification_message TEXT,
    firefly_transaction_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    foreign_amount TEXT,
    foreign_currency TEXT,
    fx_rate_date TEXT,
    fx_rate_source TEXT,
    UNIQUE(channel, source_message_id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    draft_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (draft_id) REFERENCES drafts(id)
);

CREATE TABLE IF NOT EXISTS attachment_hashes (
    sha256 TEXT PRIMARY KEY,
    draft_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (draft_id) REFERENCES drafts(id)
);

CREATE TABLE IF NOT EXISTS account_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL UNIQUE,
    firefly_account_id INTEGER,
    account_type TEXT NOT NULL,
    currency TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS merchant_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    category TEXT,
    destination_alias TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(pattern, priority)
);

CREATE TABLE IF NOT EXISTS fx_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_currency TEXT NOT NULL,
    quote_currency TEXT NOT NULL,
    rate TEXT NOT NULL,
    rate_date TEXT NOT NULL,
    rate_type TEXT NOT NULL DEFAULT 'market',
    source TEXT,
    manual_override INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(base_currency, quote_currency, rate_date, source)
);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id INTEGER NOT NULL,
    old_values TEXT,
    new_values TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_message ON drafts(channel, source_message_id);
CREATE INDEX IF NOT EXISTS idx_audit_object ON audit_events(object_type, object_id);
