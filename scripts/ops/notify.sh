#!/usr/bin/env bash
# Personal ERP — Alert notification script.
# Called by systemd OnFailure=personal-treasury-backup-alert@%n.service
# Usage: notify.sh <unit-name>
set -euo pipefail

UNIT_NAME="${1:-unknown}"
STATE_DIR="${STATE_DIR:-/var/lib/personal-treasury-backup}"

# Select state file based on unit name
case "$UNIT_NAME" in
  *stalecheck*) STATE_FILE="${STATE_DIR}/last_failure_stalecheck.json" ;;
  *)            STATE_FILE="${STATE_DIR}/last_failure_backup.json" ;;
esac

# Parse JSON in a single Python call (avoid multiple invocations)
if [ -f "$STATE_FILE" ]; then
    PARSED=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    stage = d.get('stage', 'unknown')
    detail = d.get('detail', 'no detail')[:200]
    # Sanitize: remove potential secrets
    for word in ('token','password','authorization','bearer','secret','key'):
        import re
        detail = re.sub(rf'(?i){word}[=:]\s*\S+', f'{word}=[REDACTED]', detail)
    print(f'{stage}|{detail}')
except Exception:
    print('state_parse_failed|JSON corrupt or unreadable')
" "$STATE_FILE" 2>/dev/null) || PARSED="state_parse_failed|python error"
    STAGE="${PARSED%%|*}"
    DETAIL="${PARSED#*|}"
else
    STAGE="no_state_file"
    DETAIL="State file not found: ${STATE_FILE}"
fi

MSG="[Personal ERP] FAILED unit=${UNIT_NAME} stage=${STAGE} host=$(hostname -s) time=$(date -Iseconds) detail=${DETAIL}"

# Write to journal (always)
echo "ALERT: ${MSG}" >&2

# Write to local failure log (persistent record)
mkdir -p "$STATE_DIR"
echo "${MSG}" >> "${STATE_DIR}/failures.log"

# Send alert via Hermes (feishu DM channel)
# hermes send reuses gateway credentials, no LLM/agent loop needed
if command -v hermes >/dev/null 2>&1; then
    hermes send --to feishu -q "$MSG" 2>/dev/null || \
        echo "WARN: hermes send failed, alert preserved in failures.log" >&2
else
    echo "WARN: hermes CLI not found, alert preserved in failures.log" >&2
fi
