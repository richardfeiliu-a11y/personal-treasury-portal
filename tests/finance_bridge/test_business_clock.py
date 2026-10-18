"""Batch 02（DATA-02）— 后端业务日单点化回归测试。

锁定两条不变量：
  1. 报表/估值面「业务今天」的唯一来源 `reporting.tools.business_today()`
     一律按 Europe/Berlin 解析：柏林午夜窗口内它与 UTC 日历日相差一天，属修正。
  2. `contracts.generated_now()` 与健康检查里的绝对时长运算仍用 UTC，
     不得被业务日改造顺手替掉。

Batch 05 收口（controller 批准的范围扩展）：FX 抓取侧四处「自己解析日期」的
缺省值（`app/fx/ecb.py`、`app/fx/service.py`、`scripts/refresh_fx_rates.py`、
`scripts/tools/backfill_historical_rates.py`）并入同一来源 —— 只改缺省日历日
选择，不改汇率算式与 fail-closed 行为。

测试矩阵沿用 `tests/finance_bridge/test_feishu_digest.py::test_resolve_business_date_matrix`
的口径（WP02 已确立的 Berlin 业务日判定）。
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "tools"))

import backfill_historical_rates  # isort: skip
from finance_bridge.app.api import report_web, reports
from finance_bridge.app.fx import ecb, service
from finance_bridge.app.reporting import contracts, fx_attribution, tools
from finance_bridge.app.reporting.tools import business_today
from finance_bridge.scripts import refresh_fx_rates

UTC = timezone.utc

# 2026-12-31T23:30Z = 柏林 2027-01-01T00:30（CET，冬令时）：跨年午夜窗口
WINTER_MIDNIGHT_UTC = datetime(2026, 12, 31, 23, 30, tzinfo=UTC)


class _FrozenDatetime(datetime):
    """只钉住 now()，其余（strptime/fromisoformat）继承 datetime 原行为。"""

    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        if tz is None:
            return WINTER_MIDNIGHT_UTC.replace(tzinfo=None)
        return WINTER_MIDNIGHT_UTC.astimezone(tz)


@pytest.fixture(autouse=True)
def _berlin_tz(monkeypatch):
    """把应用时区钉为 Europe/Berlin，避免宿主机 TZ 影响判定。"""
    monkeypatch.setattr(tools.settings, "tz", "Europe/Berlin")


@pytest.fixture
def _storage():
    from finance_bridge.app.state import reset_state
    reset_state()


# -------------------------------------------------------------------
# business_today：Berlin 口径矩阵
# -------------------------------------------------------------------

@pytest.mark.parametrize(
    ("utc_moment", "expected"),
    [
        # 冬季 UTC 23:30 → 柏林次日 00:30：Batch 02 硬性用例
        (datetime(2026, 12, 31, 23, 30, tzinfo=UTC), "2027-01-01"),
        (datetime(2026, 12, 31, 22, 59, tzinfo=UTC), "2026-12-31"),
        (datetime(2026, 11, 30, 23, 0, tzinfo=UTC), "2026-12-01"),
        # 夏季 CEST(+2)：UTC 22:30 柏林已次日
        (datetime(2026, 9, 30, 22, 30, tzinfo=UTC), "2026-10-01"),
        (datetime(2026, 9, 30, 21, 59, tzinfo=UTC), "2026-09-30"),
        # 夏令时切换日 2026-03-29 / 结束日 2026-10-25
        (datetime(2026, 3, 29, 0, 30, tzinfo=UTC), "2026-03-29"),
        (datetime(2026, 10, 25, 0, 30, tzinfo=UTC), "2026-10-25"),
        # naive 输入按 UTC 解释（禁止混用服务器本地时区）
        (datetime(2026, 12, 31, 23, 30), "2027-01-01"),
    ],
)
def test_business_today_resolves_berlin_calendar_day(utc_moment, expected):
    assert business_today(utc_moment) == expected


def test_business_today_returns_utc_day_outside_midnight_window():
    """柏林白天内两者同日 —— 证明改动不是「永远 +1 天」。"""
    noon_utc = datetime(2026, 12, 31, 12, 0, tzinfo=UTC)
    assert business_today(noon_utc) == "2026-12-31"


def test_business_today_converts_aware_non_utc_input():
    """aware 非 UTC 输入按「时刻」换算，绝不复用输入自身的日历日。

    2027-01-01 06:30 +08:00 = 2026-12-31 22:30Z = 柏林 23:30（CET）：
    取输入日历日会得到 2027-01-01，按时刻换算才是 2026-12-31。
    """
    shanghai_moment = datetime(2027, 1, 1, 6, 30, tzinfo=ZoneInfo("Asia/Shanghai"))
    assert shanghai_moment.strftime("%Y-%m-%d") == "2027-01-01"
    assert business_today(shanghai_moment) == "2026-12-31"


def test_business_today_without_arg_uses_app_timezone(monkeypatch):
    """无参路径 = 生产调用路径：必须走 app_tz()（Berlin）而非 UTC。"""
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)
    assert business_today() == "2027-01-01"
    # 同一冻结时刻的 UTC 日历日 —— ±1 天差即午夜窗口的修正量
    assert WINTER_MIDNIGHT_UTC.strftime("%Y-%m-%d") == "2026-12-31"


def test_business_today_honors_configured_timezone(monkeypatch):
    """口径来自 settings.tz，唯一来源不硬编码偏移。

    17:30Z 处柏林仍在当日、上海已跨日 —— 两点差异证明取值真的走了配置。
    """
    moment = datetime(2026, 12, 31, 17, 30, tzinfo=UTC)
    assert business_today(moment) == "2026-12-31"
    monkeypatch.setattr(tools.settings, "tz", "Asia/Shanghai")
    assert business_today(moment) == "2027-01-01"


# -------------------------------------------------------------------
# 不变量：generated_at 仍为 UTC
# -------------------------------------------------------------------

def test_generated_now_stays_utc(monkeypatch):
    """同一冻结时刻：generated_now 报 UTC 日期，business_today 报柏林日期。"""
    monkeypatch.setattr(contracts, "datetime", _FrozenDatetime)
    assert contracts.generated_now() == "2026-12-31T23:30:00+00:00"
    assert business_today(WINTER_MIDNIGHT_UTC) == "2027-01-01"


# -------------------------------------------------------------------
# 不变量：health-check 30 天重复检测窗 / checked_at 仍为 UTC
# -------------------------------------------------------------------

class _RangeRecordingClient:
    """记录 get_transactions_in_range 收到的区间；余额返回空。"""

    last_range: tuple[str, str] | None = None

    def __init__(self, settings):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get_transactions_in_range(self, start, end):
        type(self).last_range = (start, end)
        return []

    def get_account_balances(self, *args, **kwargs):
        return []


@pytest.fixture(autouse=True)
def _reset_recorder():
    """`last_range` 是 class 级状态：每例前后归零，避免用例间相互串味。"""
    _RangeRecordingClient.last_range = None
    yield
    _RangeRecordingClient.last_range = None


@pytest.fixture
def _firefly_configured(monkeypatch):
    """把 settings 的 Firefly 凭据开关钉成 True（只钉单属性，不整体替换）。

    `has_firefly_credentials` 是 `firefly_token` + `firefly_api_url` 的派生
    property，因此钉这两项即可确定性驱动它。
    """
    monkeypatch.setattr(tools.settings, "firefly_token", "test-token")
    monkeypatch.setattr(tools.settings, "firefly_api_url", "http://test/api/v1")


def test_health_check_duplicate_window_stays_utc(monkeypatch, _storage, _firefly_configured):
    """绝对时长窗（now-30d ~ now）按 UTC 计算，不随柏林业务日漂移。"""
    monkeypatch.setattr(tools, "FireflyClient", _RangeRecordingClient)
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)

    out = tools.compute_health_check()

    assert _RangeRecordingClient.last_range == ("2026-12-01", "2026-12-31")
    assert out["checked_at"] == "2026-12-31T23:30:00Z"
    # 对照：同一冻结时刻下柏林业务日已跨日 —— 两套「今天」刻意不同
    assert business_today() == "2027-01-01"


# -------------------------------------------------------------------
# 调用点：估值日默认走 business_today()
# -------------------------------------------------------------------

def test_currency_exposure_default_as_of_is_business_today(monkeypatch, _storage):
    """tools.py —— 敞口默认估值日在午夜窗口内取柏林日。"""
    monkeypatch.setattr(tools.settings, "firefly_token", "")  # 无凭据 → 不查 Firefly
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)
    assert tools.compute_currency_exposure()["fx_rates_date"] == "2027-01-01"


def test_fx_attribution_default_period_end_is_business_today(monkeypatch, _storage):
    """fx_attribution —— 期末日默认走同一来源，且起止只读一次钟。"""
    monkeypatch.setattr(fx_attribution.settings, "firefly_token", "test-token")
    monkeypatch.setattr(fx_attribution.settings, "firefly_api_url", "http://test/api/v1")
    monkeypatch.setattr(fx_attribution, "FireflyClient", _RangeRecordingClient)
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)

    clock_calls = []
    real_business_today = tools.business_today

    def counting_business_today(now: datetime | None = None) -> str:
        clock_calls.append(now)
        return real_business_today(now)

    monkeypatch.setattr(fx_attribution, "business_today", counting_business_today)

    out = fx_attribution.compute_fx_attribution()
    assert out["period"] == {"from": "2027-01-01", "to": "2027-01-01"}
    # 缺省起止各读一次钟时，跨午夜会得到 start > end（422）—— 只允许一次
    assert len(clock_calls) == 1


# -------------------------------------------------------------------
# 调用点：支出趋势缓存键与计算共用一次读钟
# -------------------------------------------------------------------

def test_spending_trends_default_as_of_reads_clock_once(monkeypatch):
    """compute_spending_trends(as_of=None)：键与 payload 同源，一次请求只读一次钟。"""
    calls: list[None] = []
    real_business_today = tools.business_today

    def counting_business_today(now: datetime | None = None) -> str:
        calls.append(now)
        return real_business_today(now)

    passed_to_compute: list[str | None] = []

    def fake_uncached(months: int = 6, as_of: str | None = None):
        passed_to_compute.append(as_of)
        return {"schema_version": "1.0", "as_of": as_of, "trends": []}

    monkeypatch.setattr(tools, "business_today", counting_business_today)
    monkeypatch.setattr(tools, "_compute_spending_trends_uncached", fake_uncached)
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)
    monkeypatch.setattr(tools.settings, "base_currency", "CNY")

    tools.clear_spending_trends_cache()
    try:
        out = tools.compute_spending_trends(months=3)
        calls_after_first_request = len(calls)
        cached_keys = list(tools._spending_cache._values)
        # TTL 内同参数二次调用命中缓存：不重算（键含业务日，跨日自然失效）
        tools.compute_spending_trends(months=3)
    finally:
        tools.clear_spending_trends_cache()

    assert calls_after_first_request == 1              # 一次请求只读一次钟
    assert passed_to_compute == ["2027-01-01"]         # 透传解析后的日期，而非未解析的 None
    assert out["as_of"] == "2027-01-01"                # 键与 payload 同源
    assert cached_keys == [("spending-trends", 3, "2027-01-01", "CNY")]
    assert len(calls) == 2                             # 二次调用只为拼键读钟，未触发重算


# -------------------------------------------------------------------
# 调用点：两门面默认估值日同源
# -------------------------------------------------------------------

def test_reports_valuation_date_defaults_to_business_today(monkeypatch):
    """reports.py —— 默认值改柏林，显式入参校验必须保持 422。"""
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)
    assert reports._valuation_date(None) == "2027-01-01"
    assert reports._valuation_date("2026-08-07") == "2026-08-07"
    with pytest.raises(HTTPException) as exc:
        reports._valuation_date("07-08-2026")
    assert exc.value.status_code == 422


def test_report_web_valuation_date_defaults_to_business_today(monkeypatch):
    """report_web.py —— 门户面缺省路径与 Hermes 面同日，非法显式入参仍 422。"""
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)
    assert report_web._valuation_date(None) == "2027-01-01"
    assert report_web._valuation_date("2026-08-07") == "2026-08-07"
    with pytest.raises(HTTPException) as exc:
        report_web._valuation_date("07-08-2026")
    assert exc.value.status_code == 422


def test_utc_today_helper_is_removed():
    """单点化：reports.py 不再保留本地 UTC「今天」实现。"""
    assert not hasattr(reports, "_utc_today")
    assert not hasattr(fx_attribution, "_today")


# -------------------------------------------------------------------
# Batch 05 收口（DATA-02）：FX 抓取侧三处缺省日期同源
# 冻结时刻 = 柏林 2027-01-01 / UTC 2026-12-31：旧实现（date.today() 与
# UTC 日）会得到 2026-12-31，故这些用例对「回退到旧默认」有牙齿。
# -------------------------------------------------------------------

class _RecordingECBClient:
    """记录每次请求的 url+params，并按窗口 endPeriod 回一行可用报价。

    汇率数值刻意无意义（1.0）：本组用例只读 provider 算出的参考日与窗口，
    不校验汇率算式。回一行数据而不是空表，是为了让 USD 与 CNY 两支序列都可用
    —— 否则 set 迭代顺序（随 PYTHONHASHSEED 变化）会让先查的那支抛
    ECBProviderError，用例退化成随机失败，也就失去了牙齿。
    """

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def get(self, url, params=None):
        p = dict(params or {})
        self.calls.append((url, p))
        return _CsvResponse(f"TIME_PERIOD,OBS_VALUE\n{p.get('endPeriod', '')},1.0\n")


class _CsvResponse:
    status_code = 200

    def __init__(self, text: str):
        self.text = text

    def raise_for_status(self):
        return None


def _usd_window(client: _RecordingECBClient) -> dict:
    params = [p for (url, p) in client.calls if ".USD." in url]
    assert len(params) == 1, client.calls
    return params[0]


def test_ecb_default_reference_window_ends_on_business_today(monkeypatch):
    """ecb.py:43 —— as_of 缺省时的参考日上界取柏林业务日，不再是 date.today()。"""
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)
    client = _RecordingECBClient()

    rate_set = ecb.ECBProvider(client=client).get_rates_to_cny(["USD"])

    params = _usd_window(client)
    assert params["endPeriod"] == "2027-01-01"
    assert params["endPeriod"] != WINTER_MIDNIGHT_UTC.strftime("%Y-%m-%d")
    # 回给自己的参考日也落在业务日：旧实现会把这一天当作「晚于 target」而丢数据
    assert rate_set.rate_date == "2027-01-01"
    # 窗口长度（21 天回溯）属抓取算式，不随收口变化
    assert params["startPeriod"] == "2026-12-11"


def test_ecb_explicit_as_of_still_wins(monkeypatch):
    """收口只改缺省值：显式 as_of 原样透传，不受冻结时钟影响。"""
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)
    client = _RecordingECBClient()

    rate_set = ecb.ECBProvider(client=client).get_rates_to_cny(["USD"], "2026-05-05")

    assert _usd_window(client)["endPeriod"] == "2026-05-05"
    assert rate_set.rate_date == "2026-05-05"


def test_refresh_ecb_rates_returns_business_today_when_nothing_to_fetch(monkeypatch):
    """service.py:16 —— 只需 CNY（不抓 ECB）时返回的 rate_date 同源。"""
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)
    out = service.refresh_ecb_rates(["CNY"], None, None, None)

    assert out["success"] is True
    assert out["rate_date"] == "2027-01-01"
    assert out["written"] == 0


def test_refresh_ecb_rates_explicit_as_of_unchanged():
    """显式 as_of 时不读钟：返回值仍是入参。"""
    assert service.refresh_ecb_rates(["CNY"], "2026-08-07", None, None)["rate_date"] == "2026-08-07"


def test_refresh_script_default_as_of_is_business_today(monkeypatch):
    """refresh_fx_rates.py:21 —— --as-of 缺省不再是 UTC 日。"""
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)
    assert refresh_fx_rates._date(None) == "2027-01-01"
    # 显式入参与其格式校验行为保持不变
    assert refresh_fx_rates._date("2026-08-07") == "2026-08-07"
    with pytest.raises(ValueError):
        refresh_fx_rates._date("07-08-2026")


# -------------------------------------------------------------------
# Batch 05 收尾（293ce78）：历史回填脚本的 ECB 窗口上界同源
# 该脚本写 fx_rates，上界若仍是 UTC 日会在柏林午夜窗口与报表估值日差一天。
# -------------------------------------------------------------------

class _StubBackfillClient:
    """`httpx.Client` 的替身：记录 url+params，按 endPeriod 回一行报价。

    脚本以 `with httpx.Client(timeout=30.0) as client` 建连，故需实现上下文
    管理器协议；响应复用 `_CsvResponse`（status_code 200 + CSV text）。回一行
    而非空表，是为了让缺省窗口一路走到解析结果，顺带证明上界没把序列截空。
    """

    def __init__(self, calls: list[tuple[str, dict]]):
        self._calls = calls

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get(self, url, params=None):
        p = dict(params or {})
        self._calls.append((url, p))
        return _CsvResponse(f"TIME_PERIOD,OBS_VALUE\n{p.get('endPeriod', '')},1.0\n")


class _StubBackfillHttpx:
    """顶替脚本命名空间里的 `httpx`（只用到 Client），全程不触网。"""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def Client(self, *args, **kwargs):  # 名字与被替身的 httpx.Client 保持一致
        return _StubBackfillClient(self.calls)


def test_backfill_default_end_period_is_business_today(monkeypatch):
    """scripts/tools/backfill_historical_rates.py:42 —— 缺省 endPeriod 不再是 UTC 日。"""
    monkeypatch.setattr(tools, "datetime", _FrozenDatetime)
    # 同时冻结脚本自己的钟：若缺省值回退成收口前的 `datetime.now(timezone.utc)`，
    # 拿到的正是 UTC 日 2026-12-31 —— 断言的 ±1 天差因此不依赖宿主日期。
    monkeypatch.setattr(backfill_historical_rates, "datetime", _FrozenDatetime)
    httpx_stub = _StubBackfillHttpx()
    monkeypatch.setattr(backfill_historical_rates, "httpx", httpx_stub)

    series = backfill_historical_rates.fetch_ecb_series("USD")

    assert len(httpx_stub.calls) == 1, httpx_stub.calls
    url, params = httpx_stub.calls[0]
    assert url.endswith("/D.USD.EUR.SP00.A")
    assert params["endPeriod"] == "2027-01-01"
    assert params["endPeriod"] != WINTER_MIDNIGHT_UTC.strftime("%Y-%m-%d")
    # 窗口下界与三角换算属抓取算式，不随收口变化
    assert params["startPeriod"] == "2021-10-01"
    assert series == {"2027-01-01": Decimal("1.0")}

    # 显式 end_date 原样透传，不受冻结时钟影响
    backfill_historical_rates.fetch_ecb_series("USD", end_date="2026-05-05")
    assert httpx_stub.calls[-1][1]["endPeriod"] == "2026-05-05"
