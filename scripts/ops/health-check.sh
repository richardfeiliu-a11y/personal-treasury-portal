#!/usr/bin/env bash
# Health check / patrol script for Personal Treasury stack (D02: 唯一巡检入口)
#
# 职责（WP03：并入原 watchdog.sh 的独有职责，watchdog.sh 不原样恢复）：
#   - Docker compose 服务与必需容器清单（缺一即告警）
#   - Firefly API 探测（区分「不可达」与「未认证 401=可达」，
#     未认证请求不再误判 API 不可用）
#   - Bridge /healthz 与 /health/freshness（业务任务新鲜度，异常告警）
#   - Bridge /v1/reports/health-check 的 fx_freshness（REL-02：critical/
#     不可核验→FAIL+告警；warning→仅记录，连休间隙属常态）
#   - report-web 容器内 /healthz
#   - 磁盘 / 内存 / swap / 24h OOM
#   - Hermes 服务存活（仅判定服务级；MCP 工具可用性不由此判定，
#     需 WP01 真实网关验证联动，输出 NOTE 不计 FAIL）
# 任一 FAIL 汇总后经 hermes send 尽力告警（不掩盖退出码）。
set -euo pipefail

FAIL=0
ALERTS=()

echo "=== Personal Treasury Patrol $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# 仓库根：自定位优先（脚本在 scripts/ops/），REPO_ROOT 仅显式存在时覆盖
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
cd "${REPO_ROOT}"

send_alert() {
    local msg="$1"
    echo "PATROL ALERT: $msg" >&2
    ALERTS+=("$msg")
    # 告警投递显式开关：生产 unit 设 PATROL_ALERT_ENABLED=1（见
    # personal-treasury-patrol.service）；开发/本地运行默认关闭，
    # 避免误经本机 hermes 凭据向真实渠道发送（WP03 教训：本地手工
    # 执行曾误发真实飞书消息）。
    if [ "${PATROL_ALERT_ENABLED:-0}" != "1" ]; then
        echo "  NOTE: PATROL_ALERT_ENABLED!=1，告警仅记录本输出（不投递）" >&2
        return 0
    fi
    # 尽力投递：沿用 notify.sh 验证过的 hermes send 能力；失败只记 journal，
    # 不改变巡检退出码（告警链路自身状态由 WP04 通知路径单独覆盖）。
    local bin="${HERMES_BIN:-$(command -v hermes || true)}"
    if [ -n "$bin" ] && [ -x "$bin" ]; then
        "$bin" send --to feishu -q "[Personal Treasury Patrol] $msg" >/dev/null 2>&1 || \
            echo "  WARN: hermes send failed（告警保留在 journal/ALERTS）" >&2
    else
        echo "  WARN: hermes 不可用，告警仅记录 journal" >&2
    fi
}

# Check Docker services
echo ""
echo "[Docker Services]"
docker compose -f infra/compose.yaml ps 2>/dev/null || {
    echo "  FAIL: docker compose ps failed"
    FAIL=1
}

# 必需容器清单（原 watchdog 职责）：compose 项目名 personal-treasury
echo ""
echo "[Required Containers]"
REQUIRED_CONTAINERS=(
    personal-treasury-bridge-1
    personal-treasury-cron-1
    personal-treasury-firefly-1
    personal-treasury-db-1
    personal-treasury-report-web-1
    personal-treasury-cloudflared-1
)
RUNNING_CONTAINERS="$(docker ps --format '{{.Names}}' 2>/dev/null || echo "")"
for container in "${REQUIRED_CONTAINERS[@]}"; do
    if ! echo "$RUNNING_CONTAINERS" | grep -q "^${container}$"; then
        echo "  FAIL: ${container} NOT running"
        send_alert "Container ${container} is NOT running!"
        FAIL=1
    fi
done
[ $FAIL -eq 0 ] && echo "  OK: all ${#REQUIRED_CONTAINERS[@]} required containers running" || true

# Check Firefly health（WP03 语义修正：未认证 401 = API 可达）
echo ""
echo "[Firefly API]"
FF_URL="http://127.0.0.1:18080/api/v1/about"
FF_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Accept: application/json" --max-time 10 "$FF_URL" 2>/dev/null || true)"
FF_CODE="${FF_CODE:-000}"
case "$FF_CODE" in
    000)
        echo "  FAIL: Firefly 不可达（连接失败/超时）"
        send_alert "Firefly unreachable (connection failed)"
        FAIL=1
        ;;
    401|403)
        echo "  OK: Firefly API 可达（未认证探测 ${FF_CODE}；凭据仅在 Bridge 内，不外发）"
        ;;
    200)
        VERSION="$(curl -s --max-time 10 "$FF_URL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('version','unknown'))" 2>/dev/null || echo "unknown")"
        echo "  OK: Firefly running (v${VERSION})"
        ;;
    *)
        # RV-07：「认证保护下可达」（401/403）之外的一律判 FAIL——业务端点
        # 错误/无法核验不得记录成巡检成功。
        echo "  FAIL: Firefly API 异常 ${FF_CODE}（业务端点错误/无法核验）"
        send_alert "Firefly API unhealthy (HTTP ${FF_CODE})"
        FAIL=1
        ;;
esac

# Check Bridge health
echo ""
echo "[Finance Bridge]"
if curl -sf --max-time 10 http://127.0.0.1:18711/healthz > /dev/null 2>&1; then
    echo "  OK: Bridge responding"
else
    echo "  FAIL: Bridge not responding"
    send_alert "Bridge /healthz not responding"
    FAIL=1
fi

# 业务任务新鲜度（原 watchdog 职责；口径见 WP04 六态语义）
echo ""
echo "[Bridge Freshness]"
FRESH_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:18711/health/freshness 2>/dev/null || true)"
FRESH_CODE="${FRESH_CODE:-000}"
if [ "$FRESH_CODE" != "200" ]; then
    # RV-07：freshness 无法获取 → FAIL（错误不能记成巡检成功）。
    echo "  FAIL: /health/freshness HTTP ${FRESH_CODE}（无法确认任务新鲜度）"
    send_alert "Freshness endpoint not OK (HTTP ${FRESH_CODE})"
    FAIL=1
else
    FRESH_RESP="$(curl -sS --max-time 10 http://127.0.0.1:18711/health/freshness 2>/dev/null || echo "")"
    FRESH_STATUS="$(echo "$FRESH_RESP" | python3 -c "import sys, json; print(json.load(sys.stdin).get('status', 'unknown'))" 2>/dev/null || echo "unknown")"
    # RV-03：区分「本轮巡检是否执行完成」与「被监测业务是否健康」。
    # 自身 patrol_health_check 的旧结果不参与本轮判定（否则首次上线/失败后
    # 永用自己的旧失败证明本次失败）；仅自身 stale（长期未成功、疑似停跑）
    # 单独 FAIL。无 state 字段的老响应回退 is_stale 判定。
    SELF_STATE="$(echo "$FRESH_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for j in d.get('jobs', []):
    if j.get('job_name') == 'patrol_health_check':
        print(j.get('state', ''))
        break
" 2>/dev/null || echo "")"
    OTHER_STALE="$(echo "$FRESH_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
bad = []
for j in d.get('jobs', []):
    if j.get('job_name') == 'patrol_health_check':
        continue
    st = j.get('state')
    if st is None:
        if j.get('is_stale'):
            bad.append(j.get('job_name', '?'))
    elif st not in ('healthy', 'disabled'):
        bad.append(j.get('job_name', '?'))
print(', '.join(bad))
" 2>/dev/null || echo "parse_error")"
    # AUD-26：汇率刷新作业单独显式核验。理由（生产 2026-09-22）：该作业与 patrol
    # 同刻触发，patrol 读到的是刷新**之前**的状态；即便读取时点正确，"作业失败"
    # 也必须独立于"库还新不新"被判出——库里有前向填充的旧值会让表级检查继续 OK。
    FX_JOB_STATE="$(echo "$FRESH_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for j in d.get('jobs', []):
    if j.get('job_name') == 'fx_rate_refresh':
        print(j.get('state', ''))
        break
" 2>/dev/null || echo "")"
    if [ "$FX_JOB_STATE" = "failed" ] || [ "$FX_JOB_STATE" = "never_succeeded" ]; then
        echo "  FAIL: fx_rate_refresh 作业未成功（state=${FX_JOB_STATE}）"
        send_alert "fx_rate_refresh job not successful (state=${FX_JOB_STATE})"
        FAIL=1
    fi

    if [ -n "$OTHER_STALE" ]; then
        echo "  FAIL: freshness ${FRESH_STATUS}（stale: ${OTHER_STALE}）"
        send_alert "Freshness status degraded! Stale jobs: ${OTHER_STALE}"
        FAIL=1
    elif [ "$SELF_STATE" = "stale" ]; then
        echo "  FAIL: patrol self stale（巡检长期未成功，疑似停跑）"
        send_alert "Patrol has not succeeded within threshold (self stale)"
        FAIL=1
    elif [ "$SELF_STATE" = "unknown" ]; then
        echo "  WARN: patrol self unknown（自身记录不可读，不计 FAIL）"
    else
        echo "  OK: freshness healthy"
    fi
fi

# Check FX freshness（REL-02 收尾）
echo ""
echo "[FX Freshness]"
# 消费 Bridge 数据面健康检查的 fx_freshness 项（阈值语义与
# 处置见 docs/operations/runbook.md「汇率库新鲜度检查」）。
# /v1/* 路径需内部 token（Bridge main.py 认证中间件）；生产 unit 经
# EnvironmentFile=digest.env 提供。本地/开发通常无 token —— 显式
# NOTE 跳过（同 record_patrol_outcome 先例），不冒充核验也不误报 FAIL。
if [ -z "${BRIDGE_INTERNAL_TOKEN:-}" ]; then
    echo "  NOTE: BRIDGE_INTERNAL_TOKEN 未设置，跳过 fx_freshness 消费（生产 unit 经 EnvironmentFile 提供）"
else
    FXH_URL="http://127.0.0.1:18711/v1/reports/health-check"
    FXH_AUTH=(-H "Authorization: Bearer ${BRIDGE_INTERNAL_TOKEN}")
    FXH_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${FXH_AUTH[@]}" "$FXH_URL" 2>/dev/null || true)"
    FXH_CODE="${FXH_CODE:-000}"
    if [ "$FXH_CODE" != "200" ]; then
        # RV-07 口径：无法核验不得记成巡检成功 → FAIL。
        echo "  FAIL: /v1/reports/health-check HTTP ${FXH_CODE}（无法核验 fx_freshness）"
        send_alert "fx_freshness unverifiable (HTTP ${FXH_CODE})"
        FAIL=1
    else
        FX_STATUS="$(curl -sS --max-time 10 "${FXH_AUTH[@]}" "$FXH_URL" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('checks', {}).get('fx_freshness', {}).get('status', 'missing'))
" 2>/dev/null || echo parse_error)"
        case "$FX_STATUS" in
            ok)
                echo "  OK: fx_freshness ok"
                ;;
            warning)
                # 5–10 天间隙（ECB 圣诞/复活节连休）属常态：只记录不计 FAIL、
                # 不投递告警——节假 ⚠ 由每日 digest 负责，避免每 6h 刷屏。
                echo "  WARN: fx_freshness warning（连休间隙属常态，不计 FAIL；见 runbook）"
                ;;
            critical)
                echo "  FAIL: fx_freshness critical（汇率刷新链确定性坏了）"
                send_alert "fx_freshness CRITICAL: 汇率库新鲜度检查失败"
                FAIL=1
                ;;
            *)
                # missing/parse_error/未知状态一律按无法核验处理（RV-07）。
                echo "  FAIL: fx_freshness 状态不可核验（${FX_STATUS}）"
                send_alert "fx_freshness unverifiable (status=${FX_STATUS})"
                FAIL=1
                ;;
        esac

        # AUD-26：必需币种停滞（独立检查项）。表级 fx_freshness 只要有任一币种
        # 新鲜就恒为 ok，因此「某非零余额币种停在很久以前」只能由本项发现
        # （陈旧但仍然存在的汇率会被 effective_rate 前向填充，fx_complete 也不会报）。
        FX_REQ="$(curl -sS --max-time 10 "${FXH_AUTH[@]}" "$FXH_URL" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
c = d.get('checks', {}).get('fx_required_currency_staleness')
if c is None:
    print('missing')
else:
    det = c.get('detail') or {}
    if det.get('applicable') is False:
        print('not_applicable')
    else:
        stale = det.get('stale_currencies') or []
        print((c.get('status', 'missing')) + '|' + ','.join(stale))
" 2>/dev/null || echo parse_error)"
        FX_REQ_STATUS="${FX_REQ%%|*}"
        FX_REQ_STALE="${FX_REQ#*|}"
        case "$FX_REQ_STATUS" in
            ok)              echo "  OK: 必需币种汇率新鲜" ;;
            not_applicable)  echo "  NOTE: 必需币种检查不适用（Firefly 未配置）" ;;
            warning)
                echo "  WARN: 必需币种汇率偏旧（${FX_REQ_STALE}）"
                ;;
            critical)
                echo "  FAIL: 必需币种汇率过旧（${FX_REQ_STALE}）"
                send_alert "fx_required_currency_staleness CRITICAL: ${FX_REQ_STALE}"
                FAIL=1
                ;;
            *)
                echo "  FAIL: 必需币种检查状态不可核验（${FX_REQ_STATUS}）"
                send_alert "fx_required_currency_staleness unverifiable (status=${FX_REQ_STATUS})"
                FAIL=1
                ;;
        esac
    fi
fi

# Check report-web health
# report-web 不映射宿主机端口（仅经 Cloudflare Tunnel 暴露），因此无法从主机
# 直接探测。改由 docker compose exec 进入容器内检查 nginx /healthz；
# /healthz 会真实探测前端静态资源（index.html）是否存在，而非固定 200。
echo ""
echo "[Report Web]"
if docker compose -f infra/compose.yaml exec -T report-web \
    wget -q -O - http://127.0.0.1:8080/healthz > /dev/null 2>&1; then
    echo "  OK: report-web responding"
else
    echo "  FAIL: report-web not responding"
    send_alert "report-web /healthz not responding"
    FAIL=1
fi

# Check disk
echo ""
echo "[Disk Usage]"
USED=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
AVAIL=$(df -h / | tail -1 | awk '{print $4}')
echo "  Root: ${USED}% used, ${AVAIL} available"
if [ "$USED" -gt 90 ]; then
    echo "  FAIL: Disk usage above 90%"
    send_alert "CRITICAL: Disk usage at ${USED}%"
    FAIL=1
elif [ "$USED" -gt 80 ]; then
    echo "  WARN: Disk usage above 80%"
    send_alert "WARNING: Disk usage at ${USED}%"
    FAIL=1
elif [ "$USED" -gt 70 ]; then
    echo "  WARN: Disk usage above 70%"
fi

# Check memory
echo ""
echo "[Memory]"
free -h 2>/dev/null | head -2 || echo "  (free 不可用)"

# Check OOM
echo ""
echo "[OOM Events]"
OOM_COUNT=$(journalctl -k --since "24 hours ago" --no-pager 2>/dev/null | { grep "Out of memory" || true; } | wc -l | tr -d ' ')
echo "  OOM events (24h): ${OOM_COUNT}"
if [ "$OOM_COUNT" -gt 0 ]; then
    echo "  FAIL: OOM detected"
    send_alert "OOM detected in last 24h (${OOM_COUNT})"
    FAIL=1
fi

# Check Hermes（WP03 语义修正：两级判定，服务存活 ≠ MCP 工具可用）
echo ""
echo "[Hermes]"
if systemctl is-active hermes-gateway > /dev/null 2>&1; then
    echo "  OK: Hermes service active"
    echo "  NOTE: MCP 工具可用性不由此判定（服务存活≠工具可用）；"
    echo "        真实网关 MCP 冒烟待 WP01 生产验证后联动接入 patrol。"
else
    echo "  FAIL: Hermes not active"
    send_alert "Hermes gateway service not active"
    FAIL=1
fi

# Check swap
echo ""
echo "[Swap]"
swapon --show 2>/dev/null || echo "  No swap configured"

# WP04 记录源：巡检结果 best-effort 记入 Bridge 任务注册表
# （需要 BRIDGE_INTERNAL_TOKEN/BRIDGE_BASE_URL，由 digest.env 提供）；
# 记录失败不影响巡检退出码。
record_patrol_outcome() {
    if [ -z "${BRIDGE_INTERNAL_TOKEN:-}" ]; then
        echo "PATROL RECORD: skipped (BRIDGE_INTERNAL_TOKEN not set)"
        return 0
    fi
    local status="$1" reason="$2" body
    body="{\"job_name\":\"patrol_health_check\",\"status\":\"${status}\""
    if [ -n "$reason" ]; then
        body="${body},\"reason\":\"${reason}\""
    fi
    body="${body}}"
    # RV-07：记录 POST 用 -f 检查 HTTP 错误（401/500 不得冒充记录成功）；
    # 记录失败只报告，不影响巡检退出码。
    curl -sfS --max-time 10 -X POST "${BRIDGE_BASE_URL:-http://127.0.0.1:18711/v1}/jobs/record" \
        -H "Authorization: Bearer ${BRIDGE_INTERNAL_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "${body}" >/dev/null 2>&1 \
        && echo "PATROL RECORD: ${status}" \
        || echo "PATROL RECORD: failed to record (non-fatal)"
}

if [ $FAIL -eq 0 ]; then
    record_patrol_outcome "success" ""
else
    record_patrol_outcome "failure" "health-check reported ${#ALERTS[@]} alert(s)"
fi

echo ""
if [ ${#ALERTS[@]} -gt 0 ]; then
    echo "=== Patrol alerts sent: ${#ALERTS[@]} ==="
fi
echo "=== Patrol check $([ $FAIL -eq 0 ] && echo 'PASSED' || echo 'FAILED') ==="
exit $FAIL
