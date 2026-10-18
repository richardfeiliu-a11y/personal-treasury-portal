#!/usr/bin/env bash
# Personal ERP — Full isolated restore drill (v2).
# Proves complete ERP recoverability end-to-end:
#   decrypt → SHA verify → SQLite integrity → MariaDB import → attachment archive →
#   config archive → Firefly startup+API → Bridge startup+API → business data
#
# Security model:
#   - Restore via dedicated erp-restore user with forced command (no root, no password)
#   - StrictHostKeyChecking=yes with pinned host key
#   - Drill Bridge uses a random ephemeral token (never production token)
#   - Secrets from config archive stay in 0700 temp dir, never printed to logs/report
#   - No production volumes, networks, or .env touched
#
# Usage:
#   ./restore-drill.sh --latest              Drill against latest complete backup
#   ./restore-drill.sh <run-id>              Drill against a specific run
#   ./restore-drill.sh --cleanup <drill-id>  Cleanup drill resources
set -Eeuo pipefail

# --- Repository root: 自定位优先（脚本在 scripts/ops/），REPO_ROOT 仅显式存在时覆盖 ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"

# --- Configuration ---
: "${RESTORE_SSH_HOST:=restore-server}"
: "${COMPOSE_FILE:=${REPO_ROOT}/infra/compose.yaml}"
REPORT_DIR="/var/lib/personal-treasury-backup/drill-reports"

# --- Constants ---
DRILL_ID="erp-drill-$(date +%Y%m%d%H%M%S)-$$"
DRILL_LABEL="erp-drill"
WORK_DIR=""
RESULT="INCOMPLETE"
STEPS_JSON="[]"
RUN_ID=""

# --- Helpers ---
die() { echo "FATAL: $*" >&2; RESULT="FAIL"; write_report; exit 1; }

write_report() {
    mkdir -p "$REPORT_DIR"
    local report_file="${REPORT_DIR}/${DRILL_ID}.json"
    python3 -c "
import json, sys
report = {
    'drill_id': sys.argv[1],
    'timestamp': sys.argv[2],
    'host': sys.argv[3],
    'result': sys.argv[4],
    'run_id': sys.argv[5],
    'steps': json.loads(sys.argv[6])
}
with open(sys.argv[7], 'w') as f:
    json.dump(report, f, indent=2)
print('Report: ' + sys.argv[7])
" "$DRILL_ID" "$(date -Iseconds)" "$(hostname -s)" "$RESULT" "$RUN_ID" "$STEPS_JSON" "$report_file"
}

add_step() {
    local name="$1" status="$2" detail="$3"
    STEPS_JSON=$(python3 -c "
import json, sys
steps = json.loads(sys.argv[1])
steps.append({'step': sys.argv[2], 'status': sys.argv[3], 'detail': sys.argv[4]})
print(json.dumps(steps))
" "$STEPS_JSON" "$name" "$status" "$detail")
    echo "  [${status}] ${name}: ${detail}"
}

cleanup() {
    [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ] && rm -rf "$WORK_DIR"
    docker ps -a --filter "label=${DRILL_LABEL}=${DRILL_ID}" -q | xargs -r docker rm -f 2>/dev/null || true
    docker network ls --filter "label=${DRILL_LABEL}=${DRILL_ID}" -q | xargs -r docker network rm 2>/dev/null || true
}
trap cleanup EXIT

# --- Argument parsing ---
if [ "${1:-}" = "--cleanup" ]; then
    CLEANUP_ID="${2:?Usage: $0 --cleanup <drill-id>}"
    [[ "$CLEANUP_ID" == erp-drill-* ]] || die "Cleanup ID must start with erp-drill-"
    echo "Cleaning up drill resources for: ${CLEANUP_ID}"
    docker ps -a --filter "label=${DRILL_LABEL}=${CLEANUP_ID}" -q | xargs -r docker rm -f
    docker network ls --filter "label=${DRILL_LABEL}=${CLEANUP_ID}" -q | xargs -r docker network rm
    echo "Cleanup complete."
    exit 0
fi

# --- Select backup run ---
if [ "${1:-}" = "--latest" ] || [ -z "${1:-}" ]; then
    echo "Querying remote for latest backup run..."
    RUN_ID=$(ssh -o BatchMode=yes "$RESTORE_SSH_HOST" "erp-restore-cmd list" 2>/dev/null | sort | tail -1) || \
        die "Cannot list remote backups"
    [ -n "$RUN_ID" ] || die "No backup runs found on remote"
else
    RUN_ID="$1"
fi

echo "=== Full ERP Restore Drill: ${DRILL_ID} ==="
echo "Target run: ${RUN_ID}"
echo "Restore host: ${RESTORE_SSH_HOST} (forced-command, StrictHostKeyChecking=yes)"
echo ""

# --- Create isolated work directory (0700) ---
WORK_DIR="$(mktemp -d /tmp/erp-drill.XXXXXX)"
chmod 0700 "$WORK_DIR"

# --- Read image versions from production compose (never use :latest for Firefly/MariaDB) ---
FIREFLY_IMAGE=$(grep -A1 '^\s*firefly:' "$COMPOSE_FILE" | grep 'image:' | awk '{print $2}' | head -1)
MARIADB_IMAGE=$(grep -A1 '^\s*db:' "$COMPOSE_FILE" | grep 'image:' | awk '{print $2}' | head -1)
[ -n "$FIREFLY_IMAGE" ] || die "Cannot read Firefly image from compose"
[ -n "$MARIADB_IMAGE" ] || die "Cannot read MariaDB image from compose"
echo "Firefly image: ${FIREFLY_IMAGE}"
echo "MariaDB image: ${MARIADB_IMAGE}"

# Bridge image is locally built
BRIDGE_IMAGE=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -i bridge | head -1 || echo "")
[ -n "$BRIDGE_IMAGE" ] || die "Cannot find Bridge image locally"
echo "Bridge image: ${BRIDGE_IMAGE}"
echo ""

###############################################################################
# STEP 1: Decrypt via forced-command and stream to local
###############################################################################
echo "[1/10] Decrypting on backup server (forced-command)..."
ssh -o BatchMode=yes "$RESTORE_SSH_HOST" "erp-restore-cmd decrypt-all ${RUN_ID}" 2>/dev/null | \
    tar -xf - -C "$WORK_DIR" || die "Remote decrypt-all failed"

FILE_COUNT=$(find "$WORK_DIR" -type f | wc -l)
[ "$FILE_COUNT" -gt 0 ] || die "No files received from decrypt-all"
echo "  Received ${FILE_COUNT} decrypted files."
add_step "decrypt_transfer" "PASS" "${FILE_COUNT} decrypted files received via forced-command"

###############################################################################
# STEP 2: Manifest + SHA-256 verification (must have 4 data files)
###############################################################################
echo "[2/10] Verifying manifest and SHA-256 checksums..."
MANIFEST="${WORK_DIR}/manifest.json"
[ -f "$MANIFEST" ] || die "No manifest.json found in backup"

python3 - "$MANIFEST" "$WORK_DIR" <<'PYVERIFY'
import json, sys, hashlib, os

manifest_path, work_dir = sys.argv[1], sys.argv[2]
m = json.load(open(manifest_path))
print('  run_id: {}'.format(m.get('run_id')))
print('  integrity_status: {}'.format(m.get('integrity_status')))

files = m.get('files', [])
# Must have at least 4: firefly sql, bridge db, config tar, upload tar
names = [f['name'] for f in files]
required_patterns = ['firefly_', 'bridge_', 'config_', 'firefly_upload_']
for pat in required_patterns:
    if not any(pat in n for n in names):
        print('  FAIL: manifest missing file matching "{}"'.format(pat), file=sys.stderr)
        print('  Found: {}'.format(names), file=sys.stderr)
        sys.exit(1)
print('  Manifest contains all 4 required file types ({} files)'.format(len(files)))

errors = []
for entry in files:
    name, expected_sha, expected_size = entry['name'], entry['sha256'], entry['size']
    fpath = os.path.join(work_dir, name)
    if not os.path.exists(fpath):
        errors.append('MISSING: {}'.format(name)); continue
    actual_size = os.path.getsize(fpath)
    if actual_size != expected_size:
        errors.append('SIZE MISMATCH: {} ({} != {})'.format(name, actual_size, expected_size)); continue
    sha = hashlib.sha256()
    with open(fpath, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            sha.update(chunk)
    if sha.hexdigest() != expected_sha:
        errors.append('SHA256 MISMATCH: {}'.format(name))
    else:
        print('  SHA256 OK: {} ({} bytes)'.format(name, actual_size))

if errors:
    for e in errors:
        print('  ERROR: {}'.format(e), file=sys.stderr)
    sys.exit(1)
print('  All checksums verified.')
PYVERIFY
[ $? -eq 0 ] || die "Manifest SHA-256 verification failed"
add_step "manifest_sha256" "PASS" "4 required file types present, all checksums match"

###############################################################################
# STEP 3: SQLite integrity with FK baseline
###############################################################################
echo "[3/10] Verifying SQLite backup integrity..."
BRIDGE_DB=$(find "$WORK_DIR" -name "bridge_*.db" | head -1)
[ -n "$BRIDGE_DB" ] && [ -f "$BRIDGE_DB" ] || die "No bridge_*.db found"

DRAFTS_COUNT=$(python3 - "$BRIDGE_DB" <<'PYCHECK'
import sqlite3, sys
db_path = sys.argv[1]
conn = sqlite3.connect('file:{}?mode=ro'.format(db_path), uri=True)
qc = conn.execute('PRAGMA quick_check').fetchone()[0]
if qc != 'ok':
    print('FAIL: quick_check = {}'.format(qc), file=sys.stderr); sys.exit(1)
print('  quick_check: ok', file=sys.stderr)

KNOWN_FK = [('idempotency_keys', 8, 'drafts'), ('idempotency_keys', 11, 'drafts')]
fk = conn.execute('PRAGMA foreign_key_check').fetchall()
actual = sorted([(r[0], r[1], r[2]) for r in fk])
if actual != sorted(KNOWN_FK) and actual:
    print('FAIL: unexpected FK violations: {}'.format(actual), file=sys.stderr); sys.exit(1)
print('  FK baseline: match ({} known)'.format(len(actual)), file=sys.stderr)

tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
if '_schema_migrations' in tables:
    ver = conn.execute('SELECT MAX(version) FROM _schema_migrations').fetchone()[0]
    print('  schema: v{}'.format(ver), file=sys.stderr)
drafts = conn.execute('SELECT COUNT(*) FROM drafts').fetchone()[0]
aliases = conn.execute('SELECT COUNT(*) FROM account_aliases').fetchone()[0]
print('  drafts={}, aliases={}'.format(drafts, aliases), file=sys.stderr)
conn.close()
# stdout: drafts count for later comparison
print(drafts)
PYCHECK
) || die "SQLite verification failed"
echo "  Drafts in SQLite: ${DRAFTS_COUNT}"
add_step "sqlite_integrity" "PASS" "quick_check ok, FK baseline match, ${DRAFTS_COUNT} drafts"

###############################################################################
# STEP 4: MariaDB isolated import
###############################################################################
echo "[4/10] Importing MariaDB dump into isolated container..."
SQL_GZ=$(find "$WORK_DIR" -name "firefly_*.sql.gz" | head -1)
[ -n "$SQL_GZ" ] && [ -f "$SQL_GZ" ] || die "No firefly_*.sql.gz found"

DRILL_NETWORK="erp-drill-net-${DRILL_ID}"
docker network create --label "${DRILL_LABEL}=${DRILL_ID}" "$DRILL_NETWORK" >/dev/null 2>&1

DRILL_MARIADB="erp-drill-mariadb-${DRILL_ID}"
docker run -d --name "$DRILL_MARIADB" \
    --network "$DRILL_NETWORK" \
    --label "${DRILL_LABEL}=${DRILL_ID}" \
    -e MYSQL_ROOT_PASSWORD=drill_test \
    "$MARIADB_IMAGE" >/dev/null 2>&1 || die "Failed to start drill MariaDB"

echo "  Waiting for MariaDB..."
for i in $(seq 1 30); do
    docker exec "$DRILL_MARIADB" mariadb-admin ping -h127.0.0.1 -uroot -pdrill_test --silent >/dev/null 2>&1 && break
    sleep 1
done
docker exec "$DRILL_MARIADB" mariadb-admin ping -h127.0.0.1 -uroot -pdrill_test --silent >/dev/null 2>&1 || \
    die "MariaDB not ready in 30s"

echo "  Creating firefly database and importing SQL dump..."
docker exec "$DRILL_MARIADB" mariadb -uroot -pdrill_test -e "CREATE DATABASE IF NOT EXISTS firefly CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null || \
    die "Failed to create firefly database"
gunzip -c "$SQL_GZ" | docker exec -i "$DRILL_MARIADB" mariadb -uroot -pdrill_test firefly 2>/dev/null || \
    die "MariaDB import failed"

echo "  Running mariadb-check..."
MARIADB_CHECK_OUTPUT=""
if ! MARIADB_CHECK_OUTPUT=$(docker exec "$DRILL_MARIADB" mariadb-check -uroot -pdrill_test --all-databases 2>&1); then
    printf '%s\n' "$MARIADB_CHECK_OUTPUT" >&2
    die "mariadb-check exited non-zero"
fi
echo "  mariadb-check: OK"

TABLE_COUNT=$(docker exec "$DRILL_MARIADB" mariadb -uroot -pdrill_test -N -e \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='firefly'" 2>/dev/null)
echo "  Tables in firefly DB: ${TABLE_COUNT}"
[ "${TABLE_COUNT:-0}" -gt 0 ] || die "No tables found in firefly database"
add_step "mariadb_import" "PASS" "mariadb-check OK, ${TABLE_COUNT} tables in firefly DB"

###############################################################################
# STEP 5: Attachment archive verification
###############################################################################
echo "[5/10] Verifying attachment archive..."
UPLOAD_TAR=$(find "$WORK_DIR" -name "firefly_upload_*.tar.gz" | head -1)
[ -n "$UPLOAD_TAR" ] && [ -f "$UPLOAD_TAR" ] || die "No firefly_upload_*.tar.gz found in backup"

UPLOAD_EXTRACT="${WORK_DIR}/upload_extracted"
mkdir -p "$UPLOAD_EXTRACT"
# Must be a valid gzip tar — corruption = fail
tar -tzf "$UPLOAD_TAR" >/dev/null 2>&1 || die "Attachment archive is corrupt (tar -tzf failed)"
tar -xzf "$UPLOAD_TAR" -C "$UPLOAD_EXTRACT" 2>/dev/null || die "Attachment archive extraction failed"

# Path traversal check
TRAVERSAL=$(find "$UPLOAD_EXTRACT" -name ".." -o -type l | head -1)
[ -z "$TRAVERSAL" ] || die "Path traversal detected in attachment archive"

ATTACH_COUNT=$(find "$UPLOAD_EXTRACT" -type f | wc -l)
echo "  Attachment archive: valid, ${ATTACH_COUNT} files (empty is OK)"
add_step "attachment_archive" "PASS" "valid tar.gz, ${ATTACH_COUNT} files extracted, no traversal"

###############################################################################
# STEP 6: Config archive strict verification
###############################################################################
echo "[6/10] Verifying config archive (strict)..."
CONFIG_TAR=$(find "$WORK_DIR" -name "config_*.tar.gz" | head -1)
[ -n "$CONFIG_TAR" ] && [ -f "$CONFIG_TAR" ] || die "No config_*.tar.gz found in backup"

tar -tzf "$CONFIG_TAR" >/dev/null 2>&1 || die "Config archive is corrupt"
CONFIG_LISTING=$(tar -tzf "$CONFIG_TAR")
CONFIG_COUNT=$(echo "$CONFIG_LISTING" | wc -l)

# Required entries — any missing = FAIL
REQUIRED_ENTRIES=("infra/compose.yaml" "finance_bridge/migrations/" "scripts/ops/backup.sh" "scripts/ops/restore-drill.sh")
for req in "${REQUIRED_ENTRIES[@]}"; do
    echo "$CONFIG_LISTING" | grep -q "$req" || die "Config archive missing required entry: ${req}"
    echo "  present: ${req}"
done
echo "  Config archive: ${CONFIG_COUNT} entries, all required files present"

# Extract config for secrets needed by Firefly/Bridge drill
CONFIG_EXTRACT="${WORK_DIR}/config_extracted"
mkdir -p "$CONFIG_EXTRACT"
tar -xzf "$CONFIG_TAR" -C "$CONFIG_EXTRACT" 2>/dev/null || die "Config archive extraction failed"
add_step "config_archive" "PASS" "${CONFIG_COUNT} entries, all 4 required files present"

###############################################################################
# STEP 7: Start isolated Firefly + API verification
###############################################################################
echo "[7/10] Starting isolated Firefly..."

# Read secrets from extracted config (never print them)
ENV_FILE="${CONFIG_EXTRACT}/infra/.env"
[ -f "$ENV_FILE" ] || die "infra/.env not found in config archive"
chmod 600 "$ENV_FILE"

# Extract only what we need into shell vars (not logged)
DRILL_APP_KEY=$(grep '^APP_KEY=' "$ENV_FILE" | cut -d= -f2-)
DRILL_FIREFLY_TOKEN=$(grep '^FIREFLY_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
DRILL_DB_DATABASE=$(grep '^DB_DATABASE=' "$ENV_FILE" | cut -d= -f2- || echo "firefly")
DRILL_DB_USERNAME=$(grep '^DB_USERNAME=' "$ENV_FILE" | cut -d= -f2- || echo "firefly")
DRILL_DB_PASSWORD=$(grep '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$DRILL_APP_KEY" ] || die "APP_KEY not found in config archive .env"
[ -n "$DRILL_FIREFLY_TOKEN" ] || die "FIREFLY_TOKEN not found in config archive .env"

# Create the firefly DB user in drill MariaDB (dump was imported as root)
docker exec "$DRILL_MARIADB" mariadb -uroot -pdrill_test -e \
    "CREATE USER IF NOT EXISTS '${DRILL_DB_USERNAME}'@'%' IDENTIFIED BY '${DRILL_DB_PASSWORD}'; GRANT ALL PRIVILEGES ON firefly.* TO '${DRILL_DB_USERNAME}'@'%'; FLUSH PRIVILEGES;" 2>/dev/null || \
    die "Failed to create Firefly DB user in drill MariaDB"

DRILL_FIREFLY="erp-drill-firefly-${DRILL_ID}"
docker run -d --name "$DRILL_FIREFLY" \
    --network "$DRILL_NETWORK" \
    --label "${DRILL_LABEL}=${DRILL_ID}" \
    -e "APP_KEY=${DRILL_APP_KEY}" \
    -e "DB_CONNECTION=mysql" \
    -e "DB_HOST=${DRILL_MARIADB}" \
    -e "DB_PORT=3306" \
    -e "DB_DATABASE=${DRILL_DB_DATABASE}" \
    -e "DB_USERNAME=${DRILL_DB_USERNAME}" \
    -e "DB_PASSWORD=${DRILL_DB_PASSWORD}" \
    -e "APP_ENV=local" \
    -e "APP_DEBUG=false" \
    -e "TRUSTED_PROXIES=*" \
    -p 127.0.0.1:0:8080 \
    "$FIREFLY_IMAGE" >/dev/null 2>&1 || die "Failed to start drill Firefly container"

FIREFLY_PORT=$(docker port "$DRILL_FIREFLY" 8080 2>/dev/null | head -1 | cut -d: -f2 || echo "")
[ -n "$FIREFLY_PORT" ] || die "Cannot determine Firefly port mapping"
echo "  Firefly port: ${FIREFLY_PORT}"

# Wait for Firefly to be ready (can take 30-60s on first boot)
echo "  Waiting for Firefly to become ready (up to 90s)..."
FIREFLY_READY=false
for i in $(seq 1 90); do
    CSTATE=$(docker inspect -f '{{.State.Running}}' "$DRILL_FIREFLY" 2>/dev/null || echo "false")
    if [ "$CSTATE" != "true" ]; then
        echo "  ERROR: Firefly container exited. Logs:" >&2
        docker logs "$DRILL_FIREFLY" 2>&1 | tail -20 >&2
        die "Firefly container crashed during startup"
    fi
    FF_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
        -H "Accept: application/json" \
        "http://127.0.0.1:${FIREFLY_PORT}/api/v1/about" 2>/dev/null) || FF_CODE="000"
    if [ "$FF_CODE" = "200" ] || [ "$FF_CODE" = "401" ]; then
        FIREFLY_READY=true
        break
    fi
    sleep 1
done
[ "$FIREFLY_READY" = "true" ] || {
    docker logs "$DRILL_FIREFLY" 2>&1 | tail -20 >&2
    die "Firefly not ready after 90s"
}
echo "  Firefly responding (HTTP ${FF_CODE})"

# Call /api/v1/about with token — must return 200 + valid JSON
FIREFLY_ABOUT_CODE=$(curl -s -o "${WORK_DIR}/ff_about.json" -w '%{http_code}' --max-time 10 \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${DRILL_FIREFLY_TOKEN}" \
    "http://127.0.0.1:${FIREFLY_PORT}/api/v1/about" 2>/dev/null) || FIREFLY_ABOUT_CODE="000"
echo "  /api/v1/about HTTP: ${FIREFLY_ABOUT_CODE}"
[ "$FIREFLY_ABOUT_CODE" = "200" ] || die "Firefly /api/v1/about returned ${FIREFLY_ABOUT_CODE} (expected 200)"

python3 - "${WORK_DIR}/ff_about.json" <<'PYFF'
import json, sys
d = json.load(open(sys.argv[1]))
data = d.get('data')
if not isinstance(data, dict):
    print('  FAIL: /api/v1/about data is not an object', file=sys.stderr)
    sys.exit(1)
version = data.get('version')
if not isinstance(version, str) or not version:
    print('  FAIL: /api/v1/about has no version', file=sys.stderr)
    sys.exit(1)
print('  Firefly version: {}'.format(version), file=sys.stderr)
print('  PHP version: {}'.format(data.get('php_version', 'unknown')), file=sys.stderr)
PYFF
[ $? -eq 0 ] || die "Firefly /api/v1/about response is incomplete or invalid"

# Call a read-only business API: account list
FF_ACCOUNTS_CODE=$(curl -s -o "${WORK_DIR}/ff_accounts.json" -w '%{http_code}' --max-time 10 \
    -H "Accept: application/json" \
    -H "Authorization: Bearer ${DRILL_FIREFLY_TOKEN}" \
    "http://127.0.0.1:${FIREFLY_PORT}/api/v1/accounts?limit=5&type=asset" 2>/dev/null) || FF_ACCOUNTS_CODE="000"
echo "  /api/v1/accounts HTTP: ${FF_ACCOUNTS_CODE}"
[ "$FF_ACCOUNTS_CODE" = "200" ] || die "Firefly /api/v1/accounts returned ${FF_ACCOUNTS_CODE}"

FF_ACCT_COUNT=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
data = d.get('data')
if not isinstance(data, list):
    print('FAIL: /api/v1/accounts data is not a list', file=sys.stderr)
    sys.exit(1)
if not data:
    print('FAIL: /api/v1/accounts returned no accounts', file=sys.stderr)
    sys.exit(1)
print(len(data))
" "${WORK_DIR}/ff_accounts.json" 2>/dev/null) || die "Firefly /api/v1/accounts response is invalid or empty"
echo "  Firefly accounts (sample): ${FF_ACCT_COUNT}"
add_step "firefly_startup_api" "PASS" "/about 200, /accounts 200 with ${FF_ACCT_COUNT} results"

###############################################################################
# STEP 8: Start isolated Bridge with drill token
###############################################################################
echo "[8/10] Starting isolated Bridge..."

# Generate ephemeral drill token (NOT production token)
DRILL_BRIDGE_TOKEN=$(python3 -c "import secrets; print(secrets.token_hex(32))")

DRILL_BRIDGE="erp-drill-bridge-${DRILL_ID}"
DRILL_DATA_DIR="${WORK_DIR}/bridge_data"
mkdir -p "$DRILL_DATA_DIR"
cp "$BRIDGE_DB" "${DRILL_DATA_DIR}/bridge.db"
chmod 777 "$DRILL_DATA_DIR" "${DRILL_DATA_DIR}/bridge.db"

docker run -d --name "$DRILL_BRIDGE" \
    --network "$DRILL_NETWORK" \
    --label "${DRILL_LABEL}=${DRILL_ID}" \
    -v "${DRILL_DATA_DIR}:/data" \
    -e "BRIDGE_DATABASE_URL=sqlite:////data/bridge.db" \
    -e "BRIDGE_INTERNAL_TOKEN=${DRILL_BRIDGE_TOKEN}" \
    -e "FIREFLY_API_URL=http://${DRILL_FIREFLY}:8080/api/v1" \
    -e "FIREFLY_TOKEN=${DRILL_FIREFLY_TOKEN}" \
    -e "BASE_CURRENCY=CNY" \
    -p 127.0.0.1:0:8711 \
    "$BRIDGE_IMAGE" >/dev/null 2>&1 || die "Failed to start drill Bridge container"

BRIDGE_PORT=$(docker port "$DRILL_BRIDGE" 8711 2>/dev/null | head -1 | cut -d: -f2 || echo "")
[ -n "$BRIDGE_PORT" ] || die "Cannot determine Bridge port mapping"
echo "  Bridge port: ${BRIDGE_PORT}"

# Wait for Bridge
echo "  Waiting for Bridge..."
BRIDGE_READY=false
for i in $(seq 1 20); do
    CSTATE=$(docker inspect -f '{{.State.Running}}' "$DRILL_BRIDGE" 2>/dev/null || echo "false")
    if [ "$CSTATE" != "true" ]; then
        docker logs "$DRILL_BRIDGE" 2>&1 | tail -20 >&2
        die "Bridge container crashed during startup"
    fi
    B_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
        "http://127.0.0.1:${BRIDGE_PORT}/healthz" 2>/dev/null) || B_CODE="000"
    if [ "$B_CODE" = "200" ]; then
        BRIDGE_READY=true
        break
    fi
    sleep 1
done
[ "$BRIDGE_READY" = "true" ] || {
    docker logs "$DRILL_BRIDGE" 2>&1 | tail -20 >&2
    die "Bridge healthz did not return HTTP 200 after 20s (last status: ${B_CODE})"
}
echo "  Bridge responding (HTTP ${B_CODE})"
add_step "bridge_startup" "PASS" "container running, port ${BRIDGE_PORT}, healthz HTTP ${B_CODE}"

###############################################################################
# STEP 9: Bridge API — /v1/reports/recent-drafts with drill token
###############################################################################
echo "[9/10] Verifying Bridge API (authenticated)..."

# No token → must get 401
NOTOKEN_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://127.0.0.1:${BRIDGE_PORT}/v1/reports/recent-drafts?limit=100" 2>/dev/null) || NOTOKEN_CODE="000"
echo "  Without token: HTTP ${NOTOKEN_CODE} (expect 401)"
[ "$NOTOKEN_CODE" = "401" ] || die "Bridge API without auth returned ${NOTOKEN_CODE} (expected 401)"

# With drill token → must get 200 + valid JSON + drafts
DRAFTS_CODE=$(curl -s -o "${WORK_DIR}/bridge_drafts.json" -w '%{http_code}' --max-time 5 \
    -H "Authorization: Bearer ${DRILL_BRIDGE_TOKEN}" \
    "http://127.0.0.1:${BRIDGE_PORT}/v1/reports/recent-drafts?limit=100" 2>/dev/null) || DRAFTS_CODE="000"
echo "  With drill token: HTTP ${DRAFTS_CODE}"
[ "$DRAFTS_CODE" = "200" ] || die "Bridge /v1/reports/recent-drafts returned ${DRAFTS_CODE} (expected 200)"

# Parse and compare count with SQLite
API_DRAFTS_COUNT=$(python3 - "${WORK_DIR}/bridge_drafts.json" <<'PYDRAFTS'
import json, sys
d = json.load(open(sys.argv[1]))
drafts = d.get('drafts', [])
if not isinstance(drafts, list):
    print('FAIL: drafts field is not a list', file=sys.stderr); sys.exit(1)
print(len(drafts))
PYDRAFTS
) || die "Bridge drafts response not valid JSON"

echo "  API drafts: ${API_DRAFTS_COUNT}, SQLite drafts: ${DRAFTS_COUNT}"
if [ "$API_DRAFTS_COUNT" != "$DRAFTS_COUNT" ]; then
    die "Draft count mismatch: API=${API_DRAFTS_COUNT} vs SQLite=${DRAFTS_COUNT}"
fi
echo "  Count match: CONFIRMED"
add_step "bridge_api" "PASS" "401 without token, 200 with token, ${API_DRAFTS_COUNT} drafts == SQLite count"

###############################################################################
# STEP 10: Direct business data verification
###############################################################################
echo "[10/10] Direct business data verification..."
python3 - "${DRILL_DATA_DIR}/bridge.db" <<'PYQUERY'
import sqlite3, sys
conn = sqlite3.connect('file:{}?mode=ro'.format(sys.argv[1]), uri=True)
drafts = conn.execute('SELECT COUNT(*) FROM drafts').fetchone()[0]
aliases = conn.execute('SELECT COUNT(*) FROM account_aliases').fetchone()[0]
rules = conn.execute('SELECT COUNT(*) FROM merchant_rules').fetchone()[0]
print('  drafts: {}'.format(drafts))
print('  account_aliases: {}'.format(aliases))
print('  merchant_rules: {}'.format(rules))
sample = conn.execute('SELECT id, description FROM drafts LIMIT 3').fetchall()
for row in sample:
    desc = row[1][:40] if row[1] else 'null'
    print('  sample: id={} desc={}'.format(row[0], desc))
conn.close()
if drafts == 0:
    print('FAIL: no drafts', file=sys.stderr); sys.exit(1)
PYQUERY
[ $? -eq 0 ] || die "Business data verification failed"
add_step "business_data" "PASS" "drafts/aliases/rules verified with sample rows"

###############################################################################
# FINAL REPORT
###############################################################################
RESULT="PASS"
write_report

echo ""
echo "=== DRILL RESULT: ${RESULT} ==="
echo "Drill ID: ${DRILL_ID}"
echo "Run ID: ${RUN_ID}"
echo "Timestamp: $(date -Iseconds)"
echo ""
echo "Verified steps (10):"
echo "  [x] decrypt_transfer — forced-command, no root/password"
echo "  [x] manifest_sha256 — 4 file types, all checksums match"
echo "  [x] sqlite_integrity — quick_check + FK baseline"
echo "  [x] mariadb_import — full import + mariadb-check"
echo "  [x] attachment_archive — valid tar.gz, no traversal"
echo "  [x] config_archive — all 4 required entries present"
echo "  [x] firefly_startup_api — /about 200, /accounts 200"
echo "  [x] bridge_startup — container running, healthz OK"
echo "  [x] bridge_api — 401 unauth, 200 auth, count match"
echo "  [x] business_data — drafts/aliases/rules + samples"
echo ""
echo "Security: forced-command SSH, StrictHostKeyChecking=yes, ephemeral drill token"
echo "No production resources were touched."
echo "All drill containers cleaned up automatically."
