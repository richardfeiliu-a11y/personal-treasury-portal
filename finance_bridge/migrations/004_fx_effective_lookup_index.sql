-- 004_fx_effective_lookup_index.sql
-- Covering index for effective_rate / historical_rate lookups:
-- WHERE base_currency=? AND quote_currency=? AND rate_date <= ?
-- ORDER BY rate_date DESC, manual_override DESC, created_at DESC LIMIT 1

CREATE INDEX IF NOT EXISTS idx_fx_effective_lookup
ON fx_rates(
    base_currency,
    quote_currency,
    rate_date DESC,
    manual_override DESC,
    created_at DESC
);
