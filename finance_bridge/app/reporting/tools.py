"""Functional tools implementations for Phase 3 MCP tools:
1. compute_health_check: Monthly health check JSON
2. compute_currency_exposure: Multi-currency net worth exposure JSON
3. compute_spending_trends: Category expense trend anomaly JSON
"""
from __future__ import annotations

import calendar
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from finance_bridge.app.config import settings
from finance_bridge.app.firefly.client import FireflyClient
from finance_bridge.app.reporting.cache import TTLFlightCache
from finance_bridge.app.storage.drafts import drafts
from finance_bridge.app.storage.fx_rates import FXRateRepository
from finance_bridge.app.storage.job_runs import JobRunRepository

logger = logging.getLogger(__name__)


# -------------------------------------------------------------------
# fx_freshness 阈值（REL-02）
# -------------------------------------------------------------------
# stale_days = business_today() − MAX(fx_rates.rate_date)（Berlin 日历日差）。
# 依据 docs/operations/fx-policy.md §降级策略：ECB 参考中间价在「周末和 ECB 休市日
# 回退到估值日之前最近可用 ECB 日期」，即库里最新日期落后于业务日是常态而非故障，
# 检查必须容忍这段正常间隙。该政策只定性规定向前填充、未给出天数，因此下面两个数字
# 是本检查的运维容忍度（不是政策常量，改这里不需要改政策）：
#   ≤4 天   ok —— 周末 + 单日假期
#   5–10 天 warning —— 圣诞/复活节等连休，仍不构成故障告警
#   >10 天  critical —— 刷新链确定性坏了：ECB 长期失败此前只表现为各报表
#            fx_complete=false（HTTP 200），没有任何告警入口
# 本项**刻意保持表级**（不分币种/类型，见 runbook「分工边界」）：
#   - 单币种缺率 → fx_complete 行级裁决；
#   - 单币种停滞（有旧率、被前向填充）→ 由下方 **fx_required_currency_staleness**
#     独立检查承担（AUD-26）。刻意不并进本项，避免把「表级过期」与
#     「某个币种没跟上」两种不同故障混成一个信号，也避免破坏既有接线。
FX_FRESHNESS_OK_WITHIN_DAYS = 4
FX_FRESHNESS_WARNING_WITHIN_DAYS = 10

# AUD-26（2026-09-22，生产 09-22 静默失败后补）：表级裁决本身**不足以**发现
# 「刷新作业失败」——只要有任意一个币种新鲜，MAX(rate_date) 就一直是新的。
# 因此本检查同时给出两个**独立**信号：
#   1. job_state：fx_rate_refresh 的六态（failed/stale/never_succeeded → 至少 warning，
#      failed/critical 直接 critical），与「库新不新」解耦；
#   2. 逐币种明细：只统计**持有非零余额**的币种（零余额币种不参与估值，
#      其长期停滞不是故障——生产观察到多个零余额币种长期无新汇率，属正常）。
# 刻意**不**收紧天数阈值：ECB 连休是常态（见 fx-policy §降级策略）。


# -------------------------------------------------------------------
# Task 3.1: Health Check
# -------------------------------------------------------------------

def _required_currency_staleness(today: date) -> dict[str, Any]:
    """参与估值的币种，其最新入库汇率是否过旧（AUD-26）。

    只统计**持有非零余额**的币种（口径见 `_nonzero_balance_currencies`）：
    零余额币种长期没有新汇率不是故障（生产观察到多个零余额币种长期无新汇率，
    报表总额不受影响，因为它们会被币种聚合规则跳过）。

    阈值复用 `FX_FRESHNESS_*` 常量：同一套「ECB 连休属常态」的容忍度。
    返回形状与其它检查项一致（`{"status", "detail"}`），并把每个币种的
    `latest_rate_date` / `stale_days` 如实列出，便于运维直接定位。
    """
    repo = FXRateRepository()
    base = (settings.base_currency or "CNY").upper()
    if not settings.has_firefly_credentials:
        # 无法得知哪些币种参与估值。**显式**声明不适用（而不是悄悄 ok）：
        # detail 里带 applicable=False 与原因，运维/巡检可据此区分
        # 「没配 Firefly」与「查过了、都新鲜」。未配置时各报表端点本就 503，
        # 此处判 warning 会让每个本地/测试环境常红，反而淹没真实告警。
        return {
            "status": "ok",
            "detail": {
                "applicable": False,
                "reason": "Firefly 未配置，无法判定参与估值的币种",
            },
        }
    required = _nonzero_balance_currencies()
    per_currency: dict[str, Any] = {}
    worst = "ok"
    for currency in sorted(required):
        if currency == base:  # 锚定币种恒为 1，不参与汇率新鲜度
            continue
        rate_date = repo.latest_rate_date_for(currency)
        if rate_date is None:
            per_currency[currency] = {"latest_rate_date": None, "stale_days": None,
                                      "status": "critical"}
            worst = "critical"
            continue
        days = (today - date.fromisoformat(rate_date)).days
        if days <= FX_FRESHNESS_OK_WITHIN_DAYS:
            c_status = "ok"
        elif days <= FX_FRESHNESS_WARNING_WITHIN_DAYS:
            c_status = "warning"
        else:
            c_status = "critical"
        per_currency[currency] = {"latest_rate_date": rate_date,
                                  "stale_days": days, "status": c_status}
        if c_status == "critical":
            worst = "critical"
        elif c_status == "warning" and worst == "ok":
            worst = "warning"

    stale = sorted(c for c, v in per_currency.items() if v["status"] != "ok")
    return {
        "status": worst,
        "detail": {
            "applicable": True,
            "required_currencies": sorted(required),
            "per_currency": per_currency,
            "stale_currencies": stale,
            "ok_within_days": FX_FRESHNESS_OK_WITHIN_DAYS,
            "warning_within_days": FX_FRESHNESS_WARNING_WITHIN_DAYS,
            "note": ("仅统计持有非零余额的币种；零余额币种停滞不告警"
                     if not stale else None),
        },
    }


def _nonzero_balance_currencies() -> set[str]:
    """当前持有**非零余额**的币种集合（AUD-26）。

    用途：把「汇率库新不新」的裁决限定在真正参与估值的币种上。零余额币种长期
    没有新汇率不是故障（生产观察到多个零余额币种长期无新汇率，而报表总额不受影响，
    因为它们会被 value_personal_scope 的币种聚合规则跳过）。

    取数口径与报表一致：`get_account_balances(include_net_worth_only=True)`，
    即排除 include_net_worth=false 的迁移清算账户 —— 它们的虚拟余额不应把某个
    币种"拉进"需要汇率的集合。任何异常都向上抛，由调用方决定如何降级
    （绝不静默返回空集合，那会让检查退化成"永远 ok"）。
    """
    if not settings.has_firefly_credentials:
        raise RuntimeError("Firefly not configured; cannot determine required currencies")
    base = (settings.base_currency or "CNY").upper()
    balances: dict[str, Decimal] = defaultdict(Decimal)
    with FireflyClient(settings) as client:
        accounts = client.get_account_balances(
            ["asset", "liabilities"], include_net_worth_only=True)
    for account in accounts:
        attrs = account.get("attributes") or {}
        currency = (attrs.get("currency_code") or base).upper()
        try:
            balances[currency] += Decimal(str(attrs.get("current_balance") or "0"))
        except Exception:
            continue
    return {currency for currency, amount in balances.items() if amount != 0}


def task_status_projection() -> list[dict[str, Any]]:
    """任务状态脱敏投影（WP04/D03）。

    字段白名单：job_name/state/required/last_success_at/last_failure_at/
    next_planned_at。刻意排除 last_failure_reason（可能含堆栈、路径、
    令牌片段）与服务端内部细节；供运维报告与既有提醒页消费。
    """
    report = JobRunRepository().get_freshness_report()
    allowed = ("job_name", "state", "required",
               "last_success_at", "last_failure_at", "next_planned_at")
    return [{k: job[k] for k in allowed} for job in report.get("jobs", [])]


def compute_health_check() -> dict[str, Any]:
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    checks: dict[str, Any] = {}
    overall_status = "ok"

    # 1. Freshness（脱敏投影：不再内嵌原始报告，防 reason/堆栈外泄）
    try:
        projection = task_status_projection()
        unhealthy = [j for j in projection
                     if j["required"] and j["state"] not in ("healthy", "disabled")]
        fr_status = "ok" if not unhealthy else "warning"
        checks["freshness"] = {
            "status": fr_status,
            "detail": {
                "unhealthy_required_tasks": [
                    {"job_name": j["job_name"], "state": j["state"]} for j in unhealthy
                ],
                "tasks": projection,
            },
        }
        if fr_status != "ok" and overall_status != "critical":
            overall_status = "warning"
    except Exception as e:
        checks["freshness"] = {"status": "critical", "detail": str(e)}
        overall_status = "critical"

    # 2. Draft Backlog
    try:
        s = drafts._storage()
        with s._connection() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) as cnt FROM drafts WHERE status NOT IN ('posted', 'cancelled') GROUP BY status"
            ).fetchall()
        counts = {r["status"]: r["cnt"] for r in rows}
        total_pending = sum(counts.values())
        if total_pending == 0:
            draft_status = "ok"
        elif total_pending <= 5:
            draft_status = "warning"
        else:
            draft_status = "critical"

        checks["draft_backlog"] = {
            "status": draft_status,
            "detail": {"total_pending": total_pending, "by_status": counts},
        }
        if draft_status == "critical":
            overall_status = "critical"
        elif draft_status == "warning" and overall_status != "critical":
            overall_status = "warning"
    except Exception as e:
        checks["draft_backlog"] = {"status": "critical", "detail": str(e)}
        overall_status = "critical"

    # 3. Suspected Duplicates (last 30 days)
    try:
        # 绝对时长窗，刻意用 UTC 而非 business_today()：查重只需覆盖连续 30 天，
        # 与「业务日是哪天」无关。
        dt_today = datetime.now(timezone.utc)
        start_30d = (dt_today - timedelta(days=30)).strftime("%Y-%m-%d")
        end_today = dt_today.strftime("%Y-%m-%d")

        dup_groups = []
        if settings.has_firefly_credentials:
            with FireflyClient(settings) as client:
                txns = client.get_transactions_in_range(start_30d, end_today)
            groups = defaultdict(list)
            for item in txns:
                sub_txns = (item.get("attributes") or {}).get("transactions") or []
                for sub in sub_txns:
                    amt = str(sub.get("amount") or "0")
                    src = str(sub.get("source_name") or "")
                    dst = str(sub.get("destination_name") or "")
                    key = (amt, src, dst)
                    groups[key].append(str(sub.get("transaction_journal_id") or item.get("id")))

            for key, ids in groups.items():
                if len(ids) >= 2:
                    dup_groups.append({
                        "amount": key[0],
                        "source": key[1],
                        "destination": key[2],
                        "count": len(ids),
                        "transaction_ids": ids,
                    })

        dup_status = "ok" if len(dup_groups) == 0 else "warning"
        checks["suspected_duplicates"] = {
            "status": dup_status,
            "detail": {"duplicate_groups_count": len(dup_groups), "groups": dup_groups},
        }
        if dup_status != "ok" and overall_status != "critical":
            overall_status = "warning"
    except Exception as e:
        checks["suspected_duplicates"] = {"status": "warning", "detail": str(e)}

    # 4. Negative Balances
    try:
        neg_accounts = []
        if settings.has_firefly_credentials:
            with FireflyClient(settings) as client:
                assets = client.get_account_balances(["asset"], include_net_worth_only=True)
            for acct in assets:
                attrs = acct.get("attributes") or {}
                name = attrs.get("name") or f"Account {acct.get('id')}"
                bal_str = str(attrs.get("current_balance") or "0")
                curr = attrs.get("currency_code") or "CNY"
                if Decimal(bal_str) < 0:
                    neg_accounts.append({
                        "id": acct.get("id"),
                        "name": name,
                        "currency": curr,
                        "balance": bal_str,
                    })

        neg_status = "ok" if len(neg_accounts) == 0 else "warning"
        checks["negative_balances"] = {
            "status": neg_status,
            "detail": {"negative_accounts_count": len(neg_accounts), "accounts": neg_accounts},
        }
        if neg_status != "ok" and overall_status != "critical":
            overall_status = "warning"
    except Exception as e:
        checks["negative_balances"] = {"status": "warning", "detail": str(e)}

    # 5. Backup Status
    try:
        s = drafts._storage()
        with s._connection() as conn:
            row = conn.execute("SELECT * FROM job_runs WHERE job_name='backup'").fetchone()
        if not row or not row["last_success_at"]:
            bk_status = "critical"
            bk_detail = "Backup job has never succeeded"
        else:
            last_ts = row["last_success_at"]
            stale_h = row["stale_after_hours"] or 26
            dt = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
            hours_ago = (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0
            if hours_ago <= stale_h:
                bk_status = "ok"
                bk_detail = f"Last backup {round(hours_ago, 1)}h ago (threshold: {stale_h}h)"
            else:
                bk_status = "critical"
                bk_detail = f"Backup stale! {round(hours_ago, 1)}h ago (threshold: {stale_h}h)"

        checks["backup"] = {"status": bk_status, "detail": bk_detail}
        if bk_status == "critical":
            overall_status = "critical"
    except Exception as e:
        checks["backup"] = {"status": "critical", "detail": str(e)}
        overall_status = "critical"

    # 6. FX 汇率库新鲜度（REL-02）
    # 表级裁决：只看 MAX(rate_date) 是否跟上业务日；单币种缺率由 fx_complete
    # 的行级裁决负责，不触发本项（阈值依据见文件顶部常量注释）。
    try:
        latest_rate_date = FXRateRepository().latest_rate_date()
        today = date.fromisoformat(business_today())
        fx_detail: dict[str, Any] = {
            "latest_rate_date": latest_rate_date,
            "business_today": today.isoformat(),
            "stale_days": None,
            "ok_within_days": FX_FRESHNESS_OK_WITHIN_DAYS,
            "warning_within_days": FX_FRESHNESS_WARNING_WITHIN_DAYS,
        }
        if latest_rate_date is None:
            fx_status = "critical"
            fx_detail["note"] = "fx_rates 表为空：汇率库从未成功写入或已被清空"
        else:
            stale_days = (today - date.fromisoformat(latest_rate_date)).days
            fx_detail["stale_days"] = stale_days
            if stale_days <= FX_FRESHNESS_OK_WITHIN_DAYS:
                fx_status = "ok"
            elif stale_days <= FX_FRESHNESS_WARNING_WITHIN_DAYS:
                fx_status = "warning"
            else:
                fx_status = "critical"

        checks["fx_freshness"] = {"status": fx_status, "detail": fx_detail}
        if fx_status == "critical":
            overall_status = "critical"
        elif fx_status == "warning" and overall_status != "critical":
            overall_status = "warning"
    except Exception as e:
        checks["fx_freshness"] = {"status": "critical", "detail": str(e)}
        overall_status = "critical"

    # 7. FX 必需币种停滞（AUD-26，独立于上面的表级 fx_freshness）
    # 动机（生产 2026-09-22）：表级 MAX 只要有任一币种新鲜就恒为"新"，因此
    # 「某币种持有非零余额、汇率却停在 53 天前」在既有两套裁决下都不可见：
    #   - fx_freshness 是表级的（设计如此，见 runbook 分工边界）；
    #   - fx_complete 只看"有没有率"：停滞币种经 effective_rate 前向填充会返回
    #     一条**旧率**（非 None），于是 missing_currencies 为空、fx_complete=true。
    # 本检查专门回答「参与估值的币种，其最新入库汇率是否太旧」。
    # 安全边界：只读；Firefly 不可用时如实记 per_currency_error 并判 warning，
    # 绝不静默通过（否则会退化成"永远 ok"的空检查）。
    try:
        today = date.fromisoformat(business_today())
        staleness = _required_currency_staleness(today)
        checks["fx_required_currency_staleness"] = staleness
        st = staleness["status"]
        if st == "critical":
            overall_status = "critical"
        elif st == "warning" and overall_status != "critical":
            overall_status = "warning"
    except Exception as e:
        checks["fx_required_currency_staleness"] = {"status": "warning", "detail": str(e)}
        if overall_status != "critical":
            overall_status = "warning"

    return {
        "status": overall_status,
        "checked_at": now_str,
        "checks": checks,
    }


# -------------------------------------------------------------------
# Task 3.2: Currency Exposure
# -------------------------------------------------------------------

def compute_currency_exposure(as_of: str | None = None) -> dict[str, Any]:
    today_str = as_of or business_today()
    # 记账本位币单一来源 settings.base_currency（ARCH-03 / Batch 13）：原先这里
    # 复制了一份 "CNY"。折算逻辑不变 —— FX 库的约定仍是 `1 quote = rate CNY`
    # （storage/fx_rates.py），非 CNY 本位的折算语义今天并不完整：唯一的非 CNY 强制
    # 拒绝只在 `api/reports.py` 的 account-balances 端点（503），本函数所在
    # currency-exposure 报表面属「不支持但未被强制拒绝」，本函数只负责不再自行认定
    # 本位币；切换本位币需同步处理 FX 表以 CNY 为基准的契约
    # （`storage/fx_rates.py:effective_rate`）。
    base = settings.base_currency.upper()
    repo = FXRateRepository()
    balances_by_currency: dict[str, Decimal] = defaultdict(Decimal)
    missing_currencies: list[str] = []
    fx_complete = True

    if settings.has_firefly_credentials:
        with FireflyClient(settings) as client:
            accounts = client.get_account_balances(
                ["asset", "liabilities"], date=today_str, include_net_worth_only=True)
        for acct in accounts:
            attrs = acct.get("attributes") or {}
            curr = (attrs.get("currency_code") or base).upper()
            bal = Decimal(str(attrs.get("current_balance") or "0"))
            atype = attrs.get("type", "").lower()
            # P1 修复：同时识别 "liability" 与 "liabilities"
            if atype == "asset":
                balances_by_currency[curr] += bal
            elif atype in ("liability", "liabilities"):
                balances_by_currency[curr] += bal  # 负债余额本身为负（如 Card A -30），直接相加

    exposures = []
    total_net_worth_cny = Decimal(0)
    for curr, bal in sorted(balances_by_currency.items()):
        if curr == base:
            cny_val = bal
        else:
            # P1 修复（第 5 项）：只使用历史汇率（as_of 当日或此前最近），
            # 不用 latest_rate —— 否则可能把 as_of 之后的未来汇率用于历史敞口（前视偏差）。
            # P2 修复：改用 effective_rate（与 Hermes net-worth 同口径，取 <= as_of 的最新一条，
            # 不限 rate_type）。historical_rate 曾优先返回 rate_type='historical' 的旧记录
            # 导致口径不一致 —— 该选择器缺陷已在审计修复中按日期优先统一修正。
            rate_info = repo.effective_rate(curr, today_str)
            if rate_info:
                cny_val = bal * Decimal(str(rate_info["rate"]))
            else:
                # 缺汇率不归零，标记为 None
                cny_val = None
                # 0 余额的币种没有实际敞口，缺汇率不应阻塞全局总额（否则
                # 一个余额为 0 的账户会让整个报表显示"汇率缺失"）。
                # 仍展示该行（cny_value=None），但不计入缺失列表、不影响 fx_complete。
                if bal != 0:
                    fx_complete = False
                    missing_currencies.append(curr)

        if cny_val is not None:
            total_net_worth_cny += cny_val
            cny_out = str(cny_val.quantize(Decimal("0.01")))
        else:
            cny_out = None
        exposures.append({
            "currency": curr,
            "balance": str(bal.quantize(Decimal("0.01"))),
            "cny_value": cny_out,
        })

    for exp in exposures:
        if exp["cny_value"] is None or total_net_worth_cny == 0:
            exp["percentage"] = None
        else:
            pct = (Decimal(str(exp["cny_value"])) / total_net_worth_cny) * Decimal(100)
            exp["percentage"] = float(pct.quantize(Decimal("0.1")))

    total_out = str(total_net_worth_cny.quantize(Decimal("0.01"))) if fx_complete else None
    return {
        "base_currency": base,
        "total_net_worth_cny": total_out,
        "fx_rates_date": today_str,
        "fx_complete": fx_complete,
        "missing_currencies": missing_currencies,
        "exposures": exposures,
    }


# -------------------------------------------------------------------
# Task 3.3: Spending Trends (v2 — MTD same-day-of-month comparison + FX normalization)
# -------------------------------------------------------------------


def app_tz() -> ZoneInfo:
    """应用时区：默认 Europe/Berlin（spec A.3：业务日期严禁用 UTC）。

    配置了非法时区名时兜底回 Europe/Berlin（与部署基线一致，fail-safe）。
    """
    from zoneinfo import ZoneInfoNotFoundError
    try:
        return ZoneInfo(settings.tz or "Europe/Berlin")
    except ZoneInfoNotFoundError:
        return ZoneInfo("Europe/Berlin")


def business_today(now: datetime | None = None) -> str:
    """业务今天：Europe/Berlin 自然日（YYYY-MM-DD），全后端「今天」的唯一来源。

    适用范围（DATA-02 收口后）：报表/估值面的默认估值日与业务日
    （`api/reports.py`、`api/report_web.py`、`reporting/tools.py`、
    `reporting/fx_attribution.py`、`reporting/net_worth_trend.py`，以及
    报表缓存键），外加 FX 抓取侧的缺省参考日（`app/fx/ecb.py` 的 ECB 窗口
    上界、`app/fx/service.py` 无币种可抓时回报的 rate_date、
    `scripts/refresh_fx_rates.py` 的 `--as-of` 缺省）。

    口径依据：docs/ARCHITECTURE.md「应用时区 Europe/Berlin」；
    docs/operations/fx-policy.md §报表展示 / §降级策略 —— 报表按「报表日 /
    估值日」取 ECB 参考中间价，该日必须是确定值，不能随 UTC 偏移漂移
    （DATA-02：Hermes 面与门户面曾在柏林午夜窗口相差一天）。

    反例（保持 UTC，勿并入本函数）：`contracts.generated_now()` 时间戳与健康
    检查里的绝对时长运算（30 天查重窗、备份 stale 小时数）—— UTC 只用于
    时刻与时长，不用于业务日历日。fx_freshness 例外：它比较的是「业务日 vs
    库内最新日期」，属日历日，故走本函数。

    `now` 仅供测试注入，naive 输入按 UTC 解释（与
    scripts/tools/feishu_digest.py:resolve_business_date 同口径），
    使服务器本地时区不参与金融日期。
    """
    if now is None:
        return datetime.now(app_tz()).strftime("%Y-%m-%d")
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now.astimezone(app_tz()).strftime("%Y-%m-%d")


def _spending_categories(sub: dict, item: dict) -> tuple[str, str, Decimal, str, str]:
    """提取支出子交易的关键字段：类别、币种、金额（正数）、日期。

    Firefly 的 withdrawal amount 为负数；支出趋势以支出金额（正数）聚合。
    """
    cat = sub.get("category_name") or sub.get("destination_name") or "Uncategorized"
    currency = (sub.get("currency_code") or settings.base_currency).upper()
    amount = abs(Decimal(str(sub.get("amount") or "0")))
    date_str = sub.get("date") or (item.get("attributes") or {}).get("created_at") or ""
    return cat, currency, amount, date_str, sub.get("type") or ""


def compute_spending_trends(months: int = 6, as_of: str | None = None) -> dict[str, Any]:
    """支出趋势（60s single-flight 缓存包装）。

    缺省业务日在此单点解析：缓存键与被计算的数据共用同一个 `resolved_as_of`，
    一次请求只读一次钟 —— 分别读钟时跨午夜会让键与 payload 落在不同业务日。
    """
    resolved_as_of = as_of or business_today()
    key = ("spending-trends", months, resolved_as_of, (settings.base_currency or "CNY").upper())
    return _spending_cache.get_or_compute(
        key,
        lambda: _compute_spending_trends_uncached(months, resolved_as_of),
    )


_spending_cache = TTLFlightCache(ttl_seconds=60)


def clear_spending_trends_cache() -> None:
    _spending_cache.clear()


def _compute_spending_trends_uncached(months: int = 6, as_of: str | None = None) -> dict[str, Any]:
    """支出趋势（v2 契约）：多币种按交易日汇率折算 CNY + MTD 同期对比。

    - `as_of` 未传时兜底读一次应用时区（Europe/Berlin）当前自然日；公开入口
      `compute_spending_trends` 已把解析好的日期传进来，不走该兜底分支。
    - 本函数只取 `as_of` 的日期分量（年/月/日），不依赖时刻，因此显式传日期
      与兜底读钟两种路径对同一业务日结果一致。
    - 当月只取 1..as_of 日（MTD）；历史各月取 1..min(current_dom, 该月最后一天)。
    - 任一笔非零交易缺汇率 → 类别行 fx_complete=False，金额/偏差为 None，anomaly=False。
    - 异常阈值：偏差 >100% 且绝对差额 ≥500 CNY 且历史窗口 ≥3 个月。
    """
    if as_of:
        as_of_dt = datetime.strptime(as_of, "%Y-%m-%d")
    else:
        as_of_dt = datetime.now(app_tz())

    as_of_str = as_of_dt.strftime("%Y-%m-%d")
    current_month_str = as_of_dt.strftime("%Y-%m")
    current_dom = as_of_dt.day
    base = (settings.base_currency or "CNY").upper()

    # 历史各月区间：结束日严格取 min(current_dom, monthrange 最后一天)（spec A.3 边界矩阵）
    hist_ranges: list[tuple[str, str]] = []
    cur_idx = as_of_dt.year * 12 + (as_of_dt.month - 1)
    for i in range(1, months + 1):
        idx = cur_idx - i
        hy, hm = divmod(idx, 12)
        hm += 1
        hist_end_day = min(current_dom, calendar.monthrange(hy, hm)[1])
        hist_ranges.append((f"{hy:04d}-{hm:02d}-01", f"{hy:04d}-{hm:02d}-{hist_end_day:02d}"))

    # 日期 → 窗口映射：一次覆盖读取后按交易日分派（Task 4 批量读取）
    window_by_date: dict[str, str] = {}
    for i in range(1, months + 1):
        idx = cur_idx - i
        hy, hm = divmod(idx, 12)
        hm += 1
        hist_end_day = min(current_dom, calendar.monthrange(hy, hm)[1])
        for day in range(1, hist_end_day + 1):
            window_by_date[f"{hy:04d}-{hm:02d}-{day:02d}"] = f"{hy:04d}-{hm:02d}"
    for day in range(1, current_dom + 1):
        window_by_date[f"{current_month_str}-{day:02d}"] = current_month_str

    # 覆盖区间：最早历史窗口 1 日 ~ as_of（单次调用）
    if hist_ranges:
        cover_start = hist_ranges[-1][0][:8] + "01"
    else:
        cover_start = f"{current_month_str}-01"
    cover_end = as_of_str

    # 聚合：类别 → CNY 金额；缺失汇率按 (类别, 币种) / (月份, 类别, 币种) 记录。
    # 金额一律 Decimal，最后以字符串输出；绝不使用二进制浮点聚合。
    repo = FXRateRepository()
    current_cny: dict[str, Decimal] = defaultdict(Decimal)
    current_missing: dict[str, set[str]] = defaultdict(set)
    past_cny: dict[tuple[str, str], Decimal] = defaultdict(Decimal)  # (month_key, category)
    past_missing: dict[tuple[str, str], set[str]] = defaultdict(set)
    past_months_with_data: set[str] = set()
    global_missing: set[str] = set()

    def _fx_cny(currency: str, date_str: str, amount: Decimal) -> Decimal | None:
        """按交易日汇率折算；CNY 恒为 1；无汇率返回 None（绝不伪造 1:1 回退）。"""
        if currency == base:
            return amount
        rate_info = repo.effective_rate(currency, date_str)
        if rate_info is None:
            return None
        return amount * Decimal(str(rate_info["rate"]))

    with FireflyClient(settings) as client:
        # 单次覆盖读取：cover_start ~ cover_end，按交易日分派到窗口（Task 4 批量读取）
        for item in client.get_transactions_in_range(cover_start, cover_end):
            for sub in (item.get("attributes") or {}).get("transactions") or []:
                cat, currency, amount, date_str, txn_type = _spending_categories(sub, item)
                if txn_type != "withdrawal":
                    continue
                if amount == 0:
                    continue
                month_key = window_by_date.get(date_str[:10])
                if month_key is None:
                    continue

                cny = _fx_cny(currency, date_str, amount)
                if cny is None:
                    global_missing.add(currency)
                    if month_key == current_month_str:
                        current_missing[cat].add(currency)
                    else:
                        past_missing[(month_key, cat)].add(currency)
                elif month_key == current_month_str:
                    current_cny[cat] += cny
                else:
                    past_months_with_data.add(month_key)
                    past_cny[(month_key, cat)] += cny

    num_past_months = max(len(past_months_with_data), 1)

    # 类别全集 = 当月 ∪ 历史
    all_categories = set(current_cny.keys())
    for (_, cat) in past_cny:
        all_categories.add(cat)
    for (_, cat) in past_missing:
        all_categories.add(cat)
    all_categories.update(current_missing.keys())

    trends: list[dict[str, Any]] = []
    for cat in sorted(all_categories):
        missing = set(current_missing.get(cat, set()))
        for month_key, _cat in past_missing:
            if _cat == cat:
                missing |= past_missing[(month_key, cat)]
        fx_complete = not missing

        if fx_complete:
            curr_val = current_cny.get(cat, Decimal(0))
            total_past = sum(past_cny.get((hs[:7], cat), Decimal(0)) for hs, _he in hist_ranges)
            avg_val = total_past / Decimal(str(num_past_months))

            if avg_val > 0:
                diff_pct = ((curr_val - avg_val) / avg_val) * Decimal(100)
            elif curr_val > 0:
                diff_pct = Decimal(1000)  # 无历史基线的类别按 1000% 展示
            else:
                diff_pct = Decimal(0)

            anomaly = bool(
                diff_pct > Decimal(100)
                and (curr_val - avg_val) >= Decimal(500)
                and num_past_months >= 3
            )

            trends.append({
                "category": cat,
                "current_month_amount": str(curr_val.quantize(Decimal("0.01"))),
                "historical_monthly_average": str(avg_val.quantize(Decimal("0.01"))),
                "deviation_percentage": float(diff_pct.quantize(Decimal("0.1"))),
                "fx_complete": True,
                "missing_currencies": sorted(missing),
                "anomaly": anomaly,
            })
        else:
            # 缺汇率：宁可不报异常，也绝不基于残缺金额产生误报（spec A.3 行级裁决）
            trends.append({
                "category": cat,
                "current_month_amount": None,
                "historical_monthly_average": None,
                "deviation_percentage": None,
                "fx_complete": False,
                "missing_currencies": sorted(missing),
                "anomaly": False,
            })

    # 偏差降序；汇率不完整行（偏差 None）置底
    trends.sort(key=lambda x: (x["deviation_percentage"] is None, -(x["deviation_percentage"] or 0)))

    return {
        "schema_version": "1.0",
        "as_of": as_of_str,
        "current_month": current_month_str,
        "comparison_window_months": months,
        "base_currency": base,
        "fx_complete": not global_missing,
        "missing_currencies": sorted(global_missing),
        "categories_count": len(trends),
        "anomalies_count": sum(1 for t in trends if t["anomaly"]),
        "trends": trends,
    }
