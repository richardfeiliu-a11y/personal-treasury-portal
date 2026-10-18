#!/usr/bin/env bash
# Restore script for MariaDB + Bridge SQLite
# Usage: ./restore.sh <backup_file.sql.gz>
#
# IMPORTANT: This script must be run on an ISOLATED environment (not production)
# for drill purposes. For production restore, use a dedicated maintenance session.
set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <backup_file.sql.gz>"
    exit 1
fi

BACKUP_FILE="$1"
RESTORE_DIR="/tmp/restore-$$"
DATE=$(date +%Y%m%d_%H%M%S)

# 仓库根：自定位优先（脚本在 scripts/ops/），REPO_ROOT 仅显式存在时覆盖
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
COMPOSE_FILE="${REPO_ROOT}/infra/compose.yaml"

mkdir -p "$RESTORE_DIR"

echo "[$(date)] Starting restore from $BACKUP_FILE..."
echo "WARNING: This will OVERWRITE the current database. Press Ctrl+C to abort."
sleep 5

# Load environment
if [ -f "${REPO_ROOT}/infra/.env" ]; then
    set -a
    source "${REPO_ROOT}/infra/.env"
    set +a
fi

# Extract SQL
gunzip -c "$BACKUP_FILE" > "${RESTORE_DIR}/restore.sql"

# Validate SQL file is not empty / corrupted
if [ ! -s "${RESTORE_DIR}/restore.sql" ]; then
    echo "ERROR: Extracted SQL file is empty. Aborting."
    rm -rf "$RESTORE_DIR"
    exit 1
fi

# Stop Firefly services (keep MariaDB running)
cd "${REPO_ROOT}"
docker compose -f "$COMPOSE_FILE" stop firefly cron bridge

# Restore MariaDB
echo "[$(date)] Restoring MariaDB..."
docker compose -f "$COMPOSE_FILE" exec -T db mysql \
    -u "${DB_USERNAME:-firefly}" \
    -p"${DB_PASSWORD}" \
    "${DB_DATABASE:-firefly}" \
    < "${RESTORE_DIR}/restore.sql"

# Restore Bridge SQLite (into Docker volume, WAL-safe)
BACKUP_BASE=$(basename "$BACKUP_FILE" | sed 's/firefly_//' | sed 's/.sql.gz//')
BRIDGE_BACKUP="/var/backups/personal-treasury/bridge_${BACKUP_BASE}.db"
if [ -f "$BRIDGE_BACKUP" ]; then
    echo "[$(date)] Restoring Bridge SQLite..."
    # Verify backup integrity before restoring
    python3 -c "
import sqlite3, sys
conn = sqlite3.connect('${BRIDGE_BACKUP}')
result = conn.execute('PRAGMA integrity_check').fetchone()[0]
conn.close()
if result != 'ok':
    print(f'ERROR: Bridge backup integrity check failed: {result}', file=sys.stderr)
    sys.exit(1)
print('Bridge backup integrity: ok')
"
    # Copy into container and replace
    docker compose -f "$COMPOSE_FILE" cp "$BRIDGE_BACKUP" bridge:/tmp/restore_bridge.db
    docker compose -f "$COMPOSE_FILE" exec -T bridge sh -c "
        rm -f /data/bridge.db-wal /data/bridge.db-shm && \
        cp /tmp/restore_bridge.db /data/bridge.db && \
        rm -f /tmp/restore_bridge.db
    "
    echo "  Bridge SQLite restored into container volume."
else
    echo "  WARN: No Bridge backup found at $BRIDGE_BACKUP; skipping."
fi

# Restart services
docker compose -f "$COMPOSE_FILE" start firefly cron bridge

echo "[$(date)] Restore complete."
echo "IMPORTANT: Run the following to verify:"
echo "  docker compose -f $COMPOSE_FILE ps"
echo "  curl -sf http://127.0.0.1:18711/healthz"
echo "  curl -sf http://127.0.0.1:18080/api/v1/about"

# Cleanup
rm -rf "$RESTORE_DIR"
