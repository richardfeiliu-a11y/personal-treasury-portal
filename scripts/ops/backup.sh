#!/usr/bin/env bash
# Personal ERP — Encrypted off-site backup with SSH streaming upload.
# 13-step flow: dump, verify, encrypt, upload (put+finalize), retain.
# Designed to be run under systemd with flock, or manually.
set -Eeuo pipefail

# --- Repository root: 自定位优先（脚本在 scripts/ops/，上两级即仓库根），REPO_ROOT 仅显式存在时覆盖 ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"

# --- Configuration (from EnvironmentFile) ---
: "${BACKUP_GPG_FINGERPRINT:?BACKUP_GPG_FINGERPRINT not set}"
: "${BACKUP_REMOTE_HOST:?BACKUP_REMOTE_HOST not set}"
: "${BACKUP_REMOTE_INBOX:?BACKUP_REMOTE_INBOX not set}"
: "${BACKUP_LOCAL_DIR:=/var/backups/personal-treasury}"
: "${BACKUP_RETENTION_DAILY:=7}"
: "${COMPOSE_FILE:=${REPO_ROOT}/infra/compose.yaml}"
: "${STATE_DIR:=/var/lib/personal-treasury-backup}"

# --- Constants ---
RUN_ID="$(date +%Y%m%d_%H%M%S)"
WORK_DIR=""
CURRENT_STAGE="init"

# --- Load infra .env for DB credentials ---
if [ -f "${REPO_ROOT}/infra/.env" ]; then
    set -a
    source "${REPO_ROOT}/infra/.env"
    set +a
fi

# --- Structured failure state ---
write_failure_state() {
    local stage="$1" exit_code="$2" detail="$3"
    mkdir -p "$STATE_DIR"
    local tmp="${STATE_DIR}/last_failure_backup.json.tmp"
    cat > "$tmp" <<EOF
{
  "stage": "${stage}",
  "exit_code": ${exit_code},
  "time": "$(date -Iseconds)",
  "host": "$(hostname -s)",
  "detail": "${detail}"
}
EOF
    mv -f "$tmp" "${STATE_DIR}/last_failure_backup.json"
    docker compose -f "$COMPOSE_FILE" exec -T -e "DETAIL_VAL=${detail}" bridge python -c "import os; from finance_bridge.app.state import init_storage; from finance_bridge.app.storage.job_runs import JobRunRepository; init_storage(); JobRunRepository().record_failure('backup', os.environ.get('DETAIL_VAL', ''))" 2>/dev/null || true
}

on_error() {
    local exit_code=$?
    local line_no="${1:-?}"
    local detail="line ${line_no}: last command failed"
    write_failure_state "$CURRENT_STAGE" "$exit_code" "$detail"
    # Cleanup work dir
    [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ] && rm -rf "$WORK_DIR"
    echo "[$(date)] BACKUP FAILED at stage=${CURRENT_STAGE} line=${line_no}" >&2
    exit "$exit_code"
}
trap 'on_error $LINENO' ERR

# --- Step 1: Create temporary work directory ---
CURRENT_STAGE="init"
WORK_DIR="$(mktemp -d /tmp/personal-treasury-backup.XXXXXX)"
chmod 0700 "$WORK_DIR"
echo "[$(date)] Backup run ${RUN_ID} started (work: ${WORK_DIR})"

# --- Step 2: MariaDB dump ---
CURRENT_STAGE="mariadb_dump"
echo "[$(date)] Dumping MariaDB..."
docker compose -f "$COMPOSE_FILE" \
    exec -T db mariadb-dump \
    --single-transaction \
    --routines \
    --triggers \
    --events \
    -u "${DB_USERNAME:-firefly}" \
    -p"${DB_PASSWORD}" \
    "${DB_DATABASE:-firefly}" \
    > "${WORK_DIR}/firefly_${RUN_ID}.sql" 2>"${WORK_DIR}/mariadb-dump.stderr"

if [ -s "${WORK_DIR}/mariadb-dump.stderr" ]; then
    echo "  WARN: mariadb-dump stderr:" >&2
    cat "${WORK_DIR}/mariadb-dump.stderr" >&2
fi
gzip -f "${WORK_DIR}/firefly_${RUN_ID}.sql"
rm -f "${WORK_DIR}/mariadb-dump.stderr"

# --- Step 2b: Firefly upload/attachment volume (fail-closed) ---
CURRENT_STAGE="firefly_upload_backup"
echo "[$(date)] Backing up Firefly upload volume..."
UPLOAD_DIR="${WORK_DIR}/firefly_upload_${RUN_ID}"
mkdir -p "$UPLOAD_DIR"

# Verify firefly container is running before attempting read
if ! docker compose -f "$COMPOSE_FILE" ps --status running firefly 2>/dev/null | grep -q firefly; then
    write_failure_state "firefly_upload_backup" 1 "Firefly container not running"
    echo "ERROR: Firefly container not running, cannot read upload volume" >&2
    exit 1
fi

# Read upload volume — failure MUST abort (no || true)
docker compose -f "$COMPOSE_FILE" \
    exec -T firefly tar -cf - -C /var/www/html/storage/upload . | \
    tar -xf - -C "$UPLOAD_DIR"

# Always produce an archive (even if empty) so manifest records it consistently
UPLOAD_COUNT=$(find "$UPLOAD_DIR" -type f | wc -l)
tar -czf "${WORK_DIR}/firefly_upload_${RUN_ID}.tar.gz" -C "$UPLOAD_DIR" .
rm -rf "$UPLOAD_DIR"
echo "  Firefly uploads: ${UPLOAD_COUNT} files archived."

# --- Step 3: SQLite backup (WAL-safe via backup API) ---
CURRENT_STAGE="sqlite_backup"
echo "[$(date)] Backing up Bridge SQLite (WAL-safe)..."
docker compose -f "$COMPOSE_FILE" \
    exec -T bridge python -c "
import sqlite3, sys
try:
    src = sqlite3.connect('file:///data/bridge.db?mode=ro', uri=True)
    dst = sqlite3.connect('/tmp/bridge_backup_${RUN_ID}.db')
    src.backup(dst)
    dst.close()
    src.close()
except Exception as e:
    print(f'FAILED: {e}', file=sys.stderr)
    sys.exit(1)
"
docker compose -f "$COMPOSE_FILE" \
    cp "bridge:/tmp/bridge_backup_${RUN_ID}.db" "${WORK_DIR}/bridge_${RUN_ID}.db"
docker compose -f "$COMPOSE_FILE" \
    exec -T bridge rm -f "/tmp/bridge_backup_${RUN_ID}.db"

# --- Step 4: SQLite integrity verification (on backup artifact, not live DB) ---
CURRENT_STAGE="integrity_check"
echo "[$(date)] Verifying backup artifact integrity..."
BACKUP_DB="${WORK_DIR}/bridge_${RUN_ID}.db"
INTEGRITY_OUTPUT=$(python3 - "$BACKUP_DB" <<'PYCHECK'
import sqlite3, sys

db_path = sys.argv[1]
conn = sqlite3.connect('file:{}?mode=ro'.format(db_path), uri=True)

# quick_check on the actual backup file
qc = conn.execute('PRAGMA quick_check').fetchone()[0]
if qc != 'ok':
    print('quick_check FAILED: {}'.format(qc), file=sys.stderr)
    sys.exit(1)
print('quick_check: ok', file=sys.stderr)

# Precise FK baseline comparison (known-difference table)
# Known violations: idempotency_keys rowid 8 -> drafts, rowid 11 -> drafts
KNOWN_FK_VIOLATIONS = [
    ('idempotency_keys', 8, 'drafts'),
    ('idempotency_keys', 11, 'drafts'),
]

fk = conn.execute('PRAGMA foreign_key_check').fetchall()
# Each row: (table, rowid, referenced_table, fk_index)
actual = sorted([(row[0], row[1], row[2]) for row in fk])
expected = sorted(KNOWN_FK_VIOLATIONS)

if actual == expected:
    print('foreign_key_check: {} known violations (baseline match)'.format(len(actual)), file=sys.stderr)
    status = 'success_with_known_fk_warnings'
elif not actual:
    print('foreign_key_check: 0 violations (clean)', file=sys.stderr)
    status = 'success'
else:
    print('foreign_key_check FAILED: unexpected violations', file=sys.stderr)
    print('  expected: {}'.format(expected), file=sys.stderr)
    print('  actual:   {}'.format(actual), file=sys.stderr)
    sys.exit(1)

conn.close()
# Last stdout line = machine-readable status
print(status)
PYCHECK
) || { echo "ERROR: integrity check failed" >&2; exit 1; }
INTEGRITY_STATUS=$(echo "$INTEGRITY_OUTPUT" | tail -1)
echo "integrity: ${INTEGRITY_STATUS}"

# --- Step 5: tar config + source code ---
CURRENT_STAGE="archive_config"
echo "[$(date)] Archiving config and source..."
tar -czf "${WORK_DIR}/config_${RUN_ID}.tar.gz" \
    -C "${REPO_ROOT}" \
    --exclude='backups' \
    --exclude='data' \
    --exclude='__pycache__' \
    --exclude='.git' \
    --exclude='.nl-*' \
    --exclude='.candidate*' \
    --exclude='migration' \
    --exclude='outputs' \
    --exclude='*.pyc' \
    --exclude='._*' \
    infra/ finance_bridge/ scripts/

# --- Step 6: Generate manifest ---
CURRENT_STAGE="manifest"
echo "[$(date)] Generating manifest..."

# Detect schema management status
SCHEMA_MGMT="legacy_unmanaged"
MIGRATION_VERSION="null"
SCHEMA_CHECK=$(docker compose -f "$COMPOSE_FILE" exec -T bridge python -c "
import sqlite3, json
conn = sqlite3.connect('file:///data/bridge.db?mode=ro', uri=True)
tables = [r[0] for r in conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")]
if '_schema_migrations' in tables:
    ver = conn.execute('SELECT MAX(version) FROM _schema_migrations').fetchone()[0]
    print(json.dumps({'management': 'versioned', 'version': ver}))
else:
    print(json.dumps({'management': 'legacy_unmanaged', 'version': None}))
conn.close()
" 2>/dev/null) || SCHEMA_CHECK='{"management": "unknown", "version": null}'

# Build manifest
MANIFEST_FILE="${WORK_DIR}/manifest.json"
cat > "$MANIFEST_FILE" <<EOF
{
  "run_id": "${RUN_ID}",
  "timestamp": "$(date -Iseconds)",
  "host": "$(hostname -s)",
  "schema_management": $(echo "$SCHEMA_CHECK" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['management']))" 2>/dev/null || echo '"unknown"'),
  "migration_version": $(echo "$SCHEMA_CHECK" | python3 -c "import sys,json; d=json.load(sys.stdin); v=d['version']; print(v if v is not None else 'null')" 2>/dev/null || echo 'null'),
  "consistency": "approximate_point_in_time",
  "integrity_status": "${INTEGRITY_STATUS}",
  "files": [
EOF

# Add file entries to manifest
FIRST=true
for f in "${WORK_DIR}"/*.sql.gz "${WORK_DIR}"/*.db "${WORK_DIR}"/*.tar.gz; do
    [ -f "$f" ] || continue
    FNAME="$(basename "$f")"
    FSIZE="$(stat -c%s "$f")"
    FSHA="$(sha256sum "$f" | cut -d' ' -f1)"
    if [ "$FIRST" = true ]; then FIRST=false; else echo "," >> "$MANIFEST_FILE"; fi
    printf '    {"name": "%s", "size": %s, "sha256": "%s"}' "$FNAME" "$FSIZE" "$FSHA" >> "$MANIFEST_FILE"
done
cat >> "$MANIFEST_FILE" <<EOF

  ]
}
EOF

# --- Step 7: GPG encrypt all files ---
CURRENT_STAGE="encrypt"
echo "[$(date)] Encrypting with GPG (fingerprint: ${BACKUP_GPG_FINGERPRINT:0:8}...)..."
for f in "${WORK_DIR}"/*.sql.gz "${WORK_DIR}"/*.db "${WORK_DIR}"/*.tar.gz "$MANIFEST_FILE"; do
    [ -f "$f" ] || continue
    gpg --batch --yes --trust-model always \
        --recipient "$BACKUP_GPG_FINGERPRINT" \
        --encrypt --output "${f}.gpg" "$f"
done

# --- Step 8: Upload files via SSH streaming (put) ---
CURRENT_STAGE="offsite_upload"
echo "[$(date)] Uploading to ${BACKUP_REMOTE_HOST}..."
for f in "${WORK_DIR}"/*.gpg; do
    [ -f "$f" ] || continue
    FNAME="$(basename "$f")"
    FSHA="$(sha256sum "$f" | cut -d' ' -f1)"
    echo "  Uploading ${FNAME}..."
    RESULT=$(ssh -o StrictHostKeyChecking=yes "$BACKUP_REMOTE_HOST" \
        "backup-receive put ${RUN_ID} ${FNAME} ${FSHA}" < "$f" 2>&1) || {
        write_failure_state "offsite_upload" 1 "Upload ${FNAME} failed: ${RESULT}"
        echo "ERROR: Upload ${FNAME} failed: ${RESULT}" >&2
        exit 1
    }
    if [[ "$RESULT" != OK* ]]; then
        write_failure_state "offsite_upload" 1 "Upload ${FNAME} rejected: ${RESULT}"
        echo "ERROR: Upload ${FNAME} rejected: ${RESULT}" >&2
        exit 1
    fi
done

# --- Step 9: Finalize (remote COMPLETE marker) ---
CURRENT_STAGE="remote_verify"
echo "[$(date)] Finalizing remote run..."
MANIFEST_GPG_SHA="$(sha256sum "${MANIFEST_FILE}.gpg" | cut -d' ' -f1)"
FINALIZE_RESULT=$(ssh -o StrictHostKeyChecking=yes "$BACKUP_REMOTE_HOST" \
    "backup-receive finalize ${RUN_ID} ${MANIFEST_GPG_SHA}" 2>&1) || {
    write_failure_state "remote_verify" 1 "Finalize failed: ${FINALIZE_RESULT}"
    echo "ERROR: Finalize failed: ${FINALIZE_RESULT}" >&2
    exit 1
}
if [[ "$FINALIZE_RESULT" != "FINALIZED" ]]; then
    write_failure_state "remote_verify" 1 "Finalize rejected: ${FINALIZE_RESULT}"
    echo "ERROR: Finalize rejected: ${FINALIZE_RESULT}" >&2
    exit 1
fi

# --- Step 10: Move encrypted files to local retention dir ---
CURRENT_STAGE="local_retain"
echo "[$(date)] Moving encrypted files to local retention..."
LOCAL_RUN_DIR="${BACKUP_LOCAL_DIR}/${RUN_ID}"
mkdir -p "$LOCAL_RUN_DIR"
chmod 0700 "$LOCAL_RUN_DIR"
mv "${WORK_DIR}"/*.gpg "$LOCAL_RUN_DIR/"

# --- Step 11: Write last_success state ---
CURRENT_STAGE="state_write"
mkdir -p "$STATE_DIR"
cat > "${STATE_DIR}/last_success.tmp" <<EOF
{
  "run_id": "${RUN_ID}",
  "time": "$(date -Iseconds)",
  "host": "$(hostname -s)",
  "files_dir": "${LOCAL_RUN_DIR}",
  "remote_finalized": true,
  "integrity_status": "${INTEGRITY_STATUS}"
}
EOF
mv -f "${STATE_DIR}/last_success.tmp" "${STATE_DIR}/last_success"
docker compose -f "$COMPOSE_FILE" exec -T bridge python -c "from finance_bridge.app.state import init_storage; from finance_bridge.app.storage.job_runs import JobRunRepository; init_storage(); JobRunRepository().record_success('backup')" 2>/dev/null || true


# --- Step 12: Cleanup temporary plaintext ---
CURRENT_STAGE="cleanup"
rm -rf "$WORK_DIR"
WORK_DIR=""

# --- Step 13: Local retention cleanup ---
CURRENT_STAGE="retention"
echo "[$(date)] Cleaning local backups older than ${BACKUP_RETENTION_DAILY} days..."
find "$BACKUP_LOCAL_DIR" -maxdepth 1 -type d -name "20*" -mtime +"$BACKUP_RETENTION_DAILY" \
    -exec rm -rf {} + 2>/dev/null || true

echo "[$(date)] Backup ${RUN_ID} completed successfully."
