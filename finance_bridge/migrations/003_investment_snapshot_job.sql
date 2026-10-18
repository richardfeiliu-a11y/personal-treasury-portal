-- 003_investment_snapshot_job.sql
-- Register investment_snapshot job in job_runs table for quarterly reminder tracking.

INSERT OR IGNORE INTO job_runs (job_name, stale_after_hours) VALUES
    ('investment_snapshot', 2400);
