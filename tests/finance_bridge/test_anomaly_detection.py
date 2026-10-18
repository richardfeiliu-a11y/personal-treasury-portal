"""异常聚合模块单测：两种数据源映射为统一异常行。"""
from __future__ import annotations

from finance_bridge.app.reporting.anomaly_detection import _anomalies_from_health, _anomalies_from_trends


def test_health_ok_produces_nothing():
    assert _anomalies_from_health({"status": "ok", "checks": {
        "backup": {"status": "ok"},
    }}) == []


def test_health_warning_maps_to_anomaly():
    health = {"status": "warning", "checks": {
        "suspected_duplicates": {
            "status": "warning",
            "detail": {"duplicate_groups_count": 2, "groups": [{"amount": "-35.00"}]},
        },
    }}
    rows = _anomalies_from_health(health)
    assert len(rows) == 1
    assert rows[0]["source"] == "health:suspected_duplicates"
    assert rows[0]["severity"] == "warning"
    assert "2" in rows[0]["message"]
    # 确定性 ID（spec A.1）：health:{name}；健康检查无金额/币种/类别
    assert rows[0]["id"] == "health:suspected_duplicates"
    assert rows[0]["category"] is None
    assert rows[0]["amount"] is None
    assert rows[0]["currency"] is None


def test_trends_anomaly_flag_maps():
    trends = {"current_month": "2026-08", "trends": [
        {"category": "餐饮", "current_month_amount": "3000.00",
         "historical_monthly_average": "1000.00", "deviation_percentage": 200.0, "anomaly": True},
        {"category": "交通", "current_month_amount": "100.00",
         "historical_monthly_average": "100.00", "deviation_percentage": 0.0, "anomaly": False},
    ]}
    rows = _anomalies_from_trends(trends)
    assert len(rows) == 1
    assert rows[0]["source"] == "spending:餐饮"
    # 确定性 ID（spec A.1）：spending_trend:{category}:{current_month}
    assert rows[0]["id"] == "spending_trend:餐饮:2026-08"
    assert rows[0]["category"] == "餐饮"
    assert rows[0]["amount"] == "3000.00"
    assert rows[0]["currency"] == "CNY"


def test_anomaly_rows_carry_structured_amount():
    """P1 修复：金额结构化字段（amount+currency）供前端 Amount 组件渲染。"""
    trends = {"current_month": "2026-08", "trends": [
        {"category": "餐饮", "current_month_amount": "3000.00",
         "historical_monthly_average": "1000.00", "deviation_percentage": 200.0, "anomaly": True},
    ]}
    rows = _anomalies_from_trends(trends)
    assert rows[0]["amount"] == "3000.00"
    assert rows[0]["currency"] == "CNY"
