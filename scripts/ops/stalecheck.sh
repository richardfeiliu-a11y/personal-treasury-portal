#!/usr/bin/env bash
# Personal ERP — Backup staleness check.
# Fails (exit 1) if no successful backup within 36 hours.
# Designed to run under systemd timer every 6 hours.
set -Eeuo pipefail

STATE_DIR="${STATE_DIR:-/var/lib/treasury-backup}"
LAST_SUCCESS_FILE="${STATE_DIR}/last_success"
MAX_AGE_HOURS=36

CURRENT_STAGE="stalecheck"

write_failure_state() {
    local detail="$1"
    mkdir -p "$STATE_DIR"
    local tmp="${STATE_DIR}/last_failure_stalecheck.json.tmp"
    cat > "$tmp" <<EOF
{
  "stage": "stalecheck",
  "exit_code": 1,
  "time": "$(date -Iseconds)",
  "host": "$(hostname -s)",
  "detail": "${detail}"
}
EOF
    mv -f "$tmp" "${STATE_DIR}/last_failure_stalecheck.json"
}

if [ ! -f "$LAST_SUCCESS_FILE" ]; then
    write_failure_state "No last_success file found — backup may have never run"
    echo "STALE: No last_success file found" >&2
    exit 1
fi

# Parse timestamp from last_success JSON
LAST_TIME=$(python3 -c "
import json, sys
from datetime import datetime, timezone, timedelta
try:
    d = json.load(open(sys.argv[1]))
    t = d.get('time', '')
    print(t)
except Exception:
    print('')
" "$LAST_SUCCESS_FILE" 2>/dev/null) || LAST_TIME=""

if [ -z "$LAST_TIME" ]; then
    write_failure_state "Cannot parse timestamp from last_success file"
    echo "STALE: Cannot parse last_success timestamp" >&2
    exit 1
fi

# Calculate age in hours (compatible with Python 3.6+)
AGE_HOURS=$(python3 -c "
import sys, re
from datetime import datetime, timezone, timedelta
try:
    ts = sys.argv[1]
    # Parse ISO 8601 with timezone offset (Python 3.6 compatible)
    m = re.match(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})?', ts)
    if not m:
        print('9999'); sys.exit(0)
    dt = datetime.strptime(m.group(1), '%Y-%m-%dT%H:%M:%S')
    if m.group(2):
        sign = 1 if m.group(2)[0] == '+' else -1
        hh, mm = int(m.group(2)[1:3]), int(m.group(2)[4:6])
        dt = dt.replace(tzinfo=timezone(timedelta(hours=sign*hh, minutes=sign*mm)))
    else:
        dt = dt.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    age = (now - dt).total_seconds() / 3600
    print('{:.1f}'.format(age))
except Exception:
    print('9999')
" "$LAST_TIME" 2>/dev/null) || AGE_HOURS="9999"

# Compare (use awk for float comparison)
IS_STALE=$(echo "$AGE_HOURS $MAX_AGE_HOURS" | awk '{print ($1 > $2) ? 1 : 0}')

if [ "$IS_STALE" -eq 1 ]; then
    write_failure_state "No successful backup in ${AGE_HOURS}h (threshold: ${MAX_AGE_HOURS}h). Last: ${LAST_TIME}"
    echo "STALE: Last backup ${AGE_HOURS}h ago (threshold: ${MAX_AGE_HOURS}h)" >&2
    exit 1
fi

echo "OK: Last backup ${AGE_HOURS}h ago (within ${MAX_AGE_HOURS}h threshold)"
