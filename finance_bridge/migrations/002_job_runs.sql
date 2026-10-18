-- 002_job_runs.sql
-- Table for tracking background job executions and freshness monitoring.

CREATE TABLE IF NOT EXISTS job_runs (
    job_name TEXT PRIMARY KEY,
    last_success_at TEXT,
    last_failure_at TEXT,
    last_failure_reason TEXT,
    stale_after_hours INTEGER DEFAULT 36
);

INSERT OR IGNORE INTO job_runs (job_name, stale_after_hours) VALUES
    ('fx_rate_refresh', 36),
    ('backup', 26),
    ('firefly_cron', 26);
