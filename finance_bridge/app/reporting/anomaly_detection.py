"""异常聚合（report-web 专用，只读）：健康检查 + 支出异常 → 统一列表。"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _anomalies_from_health(health: dict[str, Any]) -> list[dict[str, Any]]:
    """健康检查 → 异常行。（容器健康由部署层负责，health check 不含 containers 检查。）"""
    rows: list[dict[str, Any]] = []
    for name, check in (health.get("checks") or {}).items():
        status = check.get("status")
        if status == "ok":
            continue
        detail = check.get("detail") or {}
        if isinstance(detail, dict) and "duplicate_groups_count" in detail:
            message = f"疑似重复交易 {detail['duplicate_groups_count']} 组（最近30天）"
        elif name == "draft_backlog" and isinstance(detail, dict):
            message = f"待确认草稿 {detail.get('total_pending', '?')} 条"
        elif name == "negative_balances" and isinstance(detail, dict):
            message = f"负余额账户 {detail.get('negative_accounts_count', '?')} 个"
        elif name == "backup":
            message = "备份过期或从未成功"
        else:
            message = f"{name} 状态异常（{status}）"
        rows.append({
            "id": f"health:{name}",
            "source": f"health:{name}",
            "severity": status,
            "message": message,
            "category": None,
            "amount": None,
            "currency": None,
        })
    return rows


def _anomalies_from_trends(trends: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    # 确定性 ID 依赖 current_month（spec A.1：spending_trend:{category}:{current_month}）
    current_month = trends.get("current_month") or ""
    for t in trends.get("trends") or []:
        if not t.get("anomaly"):
            continue
        rows.append({
            "id": f"spending_trend:{t['category']}:{current_month}",
            "source": f"spending:{t['category']}",
            "severity": "warning",
            "message": (
                f"类别「{t['category']}」本月支出较历史月均偏差 {t['deviation_percentage']:g}%"
            ),
            "category": t["category"],
            "amount": str(t.get("current_month_amount")) if t.get("current_month_amount") is not None else None,
            "currency": "CNY",
        })
    return rows


def compute_anomalies() -> dict[str, Any]:
    """聚合两数据源的异常。调用方负责 Firefly 可用性。"""
    from finance_bridge.app.reporting.tools import compute_health_check, compute_spending_trends

    rows: list[dict[str, Any]] = []
    try:
        rows += _anomalies_from_health(compute_health_check())
    except Exception:
        rows.append({"id": "health:unavailable", "source": "health", "severity": "critical",
                     "message": "健康检查不可用", "category": None, "amount": None, "currency": None})
    try:
        rows += _anomalies_from_trends(compute_spending_trends(months=6))
    except Exception:
        rows.append({"id": "spending:unavailable", "source": "spending", "severity": "warning",
                     "message": "支出趋势不可用", "category": None, "amount": None, "currency": None})
    severity_order = {"critical": 0, "warning": 1}
    rows.sort(key=lambda r: severity_order.get(str(r["severity"]), 2))
    return {
        "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(rows),
        "anomalies": rows,
    }
