"""净资产跨面对账契约（CALC-01 / 审计计划 Batch 11）。

两个门面必须对同一账户集合 + 同一汇率给出**分位一致**的三总额：

- Hermes 面：``reporting/balance_sheet.py``（飞书日报经 MCP 读取）；
- 门户面：``reporting/personal_balance_sheet.py`` + 其内部聚合单点
  ``value_personal_scope``（report-web SPA 与净资产趋势共用）。

口径决策（Batch 11）：统一采用门户面口径 —— **逐账户按币种聚合后按币种折算**，
负债逐账户取绝对值（毛额，而非同币种净额），净资产 = 资产合计 - 负债合计。
本文件把该顺序固化为单点：三总额只能来自 ``value_personal_scope``。
"""
from __future__ import annotations

from decimal import Decimal

import pytest

try:
    import respx
    HAS_RESPX = True
except ImportError:  # pragma: no cover - 环境缺依赖时端点用例跳过
    HAS_RESPX = False

from finance_bridge.app.account_groups import load_account_groups
from finance_bridge.app.reporting import balance_sheet as hermes_balance_sheet
from finance_bridge.app.reporting.balance_sheet import compute_balance_sheet
from finance_bridge.app.reporting.personal_balance_sheet import (
    compute_personal_balance_sheet,
    value_personal_scope,
)
from finance_bridge.app.storage.fx_rates import FXRateRepository

AS_OF = "2026-08-07"
BASE = "CNY"
USD_RATE = "7.123456"
EUR_RATE = "7.87654321"


def _acct(account_id: str, name: str, acct_type: str, currency: str, balance: str,
          *, active: bool = True,
          include_net_worth: bool | int | None = True) -> dict:
    return {
        "id": account_id,
        "attributes": {
            "name": name,
            "type": acct_type,
            "currency_code": currency,
            "current_balance": balance,
            "active": active,
            "include_net_worth": include_net_worth,
        },
    }


@pytest.fixture(autouse=True)
def _pin_base_currency(monkeypatch):
    """跨面对账的前提：两个门面吃**同一个**本位币。

    Batch 13（ARCH-03）后 Hermes 面的本位币改读 settings 单例，而 settings 会被别的
    测试文件的 autouse 夹具改成 EUR 并泄漏到后续文件（见 `test_reports_endpoints` 的
    `_setup`）。这里按本文件的 BASE 钉住，否则「门户面显式传 BASE vs Hermes 面读
    settings」会随运行顺序自相矛盾。
    """
    from finance_bridge.app.config import settings as cfg_settings
    monkeypatch.setattr(cfg_settings, "base_currency", BASE)


@pytest.fixture
def groups():
    return load_account_groups()


@pytest.fixture
def repo(temp_storage):
    """多位汇率：USD 6 位小数、EUR 8 位小数（CNY 由仓库固定为 1）。"""
    r = FXRateRepository(temp_storage)
    r.upsert_market("USD", USD_RATE, AS_OF)
    r.upsert_market("EUR", EUR_RATE, AS_OF)
    return r


def _three_faces(accounts: list[dict], repo, groups):
    """同一账户集合 + 同一汇率仓库，喂给三个计算点。"""
    hermes = compute_balance_sheet(accounts, AS_OF, repo)
    scope = value_personal_scope(accounts, AS_OF, BASE, repo)
    portal = compute_personal_balance_sheet(accounts, AS_OF, BASE, repo, groups)
    return hermes, scope, portal


# 三组总额在两个门面响应里的字段名（Hermes 用 *_cny，门户用 *_base）。
_TOTAL_KEYS = (
    ("total_assets_cny", "total_assets_base"),
    ("total_liabilities_cny", "total_liabilities_base"),
    ("net_worth_cny", "net_worth_base"),
)


def _assert_faces_agree(hermes, scope, portal, *, check_fx_complete: bool = True):
    """允差 0.00：三总额在 Hermes 面 / value_personal_scope / 门户面完全相等。"""
    for hermes_key, base_key in _TOTAL_KEYS:
        assert hermes.summary[hermes_key] == scope[base_key], hermes_key
        assert hermes.summary[hermes_key] == portal["summary"][base_key], hermes_key
        if hermes.summary[hermes_key] is not None:
            assert Decimal(hermes.summary[hermes_key]) == Decimal(scope[base_key])
            assert Decimal(hermes.summary[hermes_key]) == Decimal(portal["summary"][base_key])
    if check_fx_complete:
        assert hermes.fx_complete is scope["fx_complete"] is portal["fx_complete"]


# -------------------------------------------------------------------
# 1. 多币种 exact equality（计划要求的输入形态：CNY/USD/EUR + 多位汇率）
# -------------------------------------------------------------------

MULTI_CURRENCY_ACCOUNTS = [
    _acct("5105", "银行甲存款", "asset", "CNY", "100000.00"),
    _acct("5110", "Broker A", "asset", "USD", "12345.67"),
    _acct("5103", "Bank A", "asset", "USD", "987.65"),
    _acct("5104", "Bank B", "asset", "EUR", "10000.01"),
    _acct("5201", "Card A", "liabilities", "EUR", "-12345.67"),
    _acct("5210", "银行甲消费贷", "liabilities", "USD", "-1000.00"),
]


def test_multi_currency_totals_are_cent_identical(repo, groups):
    """逐币种聚合后折算：(USD 13333.32)*7.123456 + (EUR 10000.01)*7.87654321 + CNY。

    期望值为独立手算的 Decimal 结果，非任何一侧实现的输出。
    """
    hermes, scope, portal = _three_faces(MULTI_CURRENCY_ACCOUNTS, repo, groups)
    _assert_faces_agree(hermes, scope, portal)

    expected_assets = (
        Decimal("100000.00")
        + (Decimal("12345.67") + Decimal("987.65")) * Decimal(USD_RATE)
        + Decimal("10000.01") * Decimal(EUR_RATE)
    )
    expected_liabilities = (
        Decimal("1000.00") * Decimal(USD_RATE) + Decimal("12345.67") * Decimal(EUR_RATE)
    )
    assert Decimal(scope["total_assets_base"]) == expected_assets
    assert Decimal(scope["total_liabilities_base"]) == expected_liabilities
    assert Decimal(scope["net_worth_base"]) == expected_assets - expected_liabilities
    # 字面量钉死，防止 normalize()/精度语义漂移。
    assert hermes.summary["net_worth_cny"] == "169380.1700079514"
    assert portal["summary"]["net_worth_base"] == "169380.1700079514"
    assert hermes.summary["total_assets_cny"] == "273744.8292193521"
    assert hermes.summary["total_liabilities_cny"] == "104364.6592114007"


def test_hermes_totals_are_computed_by_value_personal_scope(repo, groups, monkeypatch):
    """单点契约：Hermes 面的三总额必须**由** value_personal_scope 产出，不得另起炉灶。"""
    real = hermes_balance_sheet.value_personal_scope
    calls: list[tuple] = []

    def spy(accounts, as_of, base_currency, repository):
        calls.append((accounts, as_of, base_currency, repository))
        return real(accounts, as_of, base_currency, repository)

    monkeypatch.setattr(hermes_balance_sheet, "value_personal_scope", spy)
    hermes = compute_balance_sheet(MULTI_CURRENCY_ACCOUNTS, AS_OF, repo)

    assert len(calls) == 1, "Hermes 面应恰好调用一次统一聚合点"
    passed_accounts, passed_as_of, passed_base, passed_repo = calls[0]
    assert passed_accounts is MULTI_CURRENCY_ACCOUNTS, "应把上游原始账户集原样交给统一聚合点"
    assert passed_as_of == AS_OF
    assert passed_base == BASE
    assert passed_repo is repo
    assert hermes.summary["net_worth_cny"] == real(
        MULTI_CURRENCY_ACCOUNTS, AS_OF, BASE, repo)["net_worth_base"]


def test_hermes_response_contract_is_frozen(repo):
    """字段名与结构不变（飞书侧零感知）：只换算法，不换契约。"""
    hermes = compute_balance_sheet(MULTI_CURRENCY_ACCOUNTS, AS_OF, repo)
    assert set(hermes.summary) == {
        "total_assets_cny", "total_liabilities_cny", "net_worth_cny", "currency_count",
        "account_stats", "sign_warnings", "missing_currencies",
        "zero_balance_missing_currencies", "rates_used",
    }
    assert set(hermes.summary["account_stats"]) == {
        "excluded_include_net_worth_false",
        "skipped_inactive_zero_balance",
        "kept_inactive_nonzero_balance",
    }
    assert [s.key for s in hermes.sections] == ["assets", "liabilities"]
    assert [(r.currency, r.amount) for r in hermes.sections[0].rows] == [
        ("CNY", "100000"), ("EUR", "10000.01"), ("USD", "13333.32"),
    ]
    # 负债行仍为原逻辑产出的展示值（正数），本批次不动展示层。
    assert [(r.currency, r.amount) for r in hermes.sections[1].rows] == [
        ("EUR", "12345.67"), ("USD", "1000"),
    ]
    assert hermes.presentation.summary_markdown.count("净资产") == 1


# -------------------------------------------------------------------
# 2. 负余额负债 + 同币种正余额（溢缴/退款挂账）：毛额 vs 净额
# -------------------------------------------------------------------

def test_negative_liability_and_positive_liability_agree_across_faces(repo, groups):
    """USD 同一币种下 -1000.00 与 +300.00 两条负债：口径为逐账户绝对值毛额 1300。

    这是 Batch 11 观察到的**实际分位差**：改前 Hermes 面把同币种负债按净额
    （-700 -> 展示 700）折算，与门户面相差 4274.0736 CNY。
    """
    accounts = [
        _acct("90001", "信用卡", "liabilities", "USD", "-1000.00"),
        _acct("90002", "信用卡溢缴退款", "liabilities", "USD", "300.00"),
        _acct("90003", "现金", "asset", "CNY", "5000.00"),
    ]
    hermes, scope, portal = _three_faces(accounts, repo, groups)
    _assert_faces_agree(hermes, scope, portal)

    gross_liabilities = Decimal("1300.00") * Decimal(USD_RATE)  # 9260.4928
    assert Decimal(hermes.summary["total_liabilities_cny"]) == gross_liabilities
    assert Decimal(hermes.summary["net_worth_cny"]) == Decimal("5000.00") - gross_liabilities
    assert hermes.summary["net_worth_cny"] == "-4260.4928"

    # ③ 正余额告警逻辑不动：仍按账户报出异常正余额。
    assert len(hermes.summary["sign_warnings"]) == 1
    assert "正余额" in hermes.summary["sign_warnings"][0]


def test_pure_negative_liabilities_match_before_and_after(repo, groups):
    """常规数据（负债全为负）：毛额 == 净额，跨面本就一致，不得因本批次改动漂移。"""
    accounts = [
        _acct("90001", "信用卡", "liabilities", "USD", "-1000.00"),
        _acct("90004", "房贷", "liabilities", "EUR", "-250000.37"),
        _acct("90003", "现金", "asset", "CNY", "5000.00"),
        _acct("90005", "证券", "asset", "USD", "9999.99"),
    ]
    hermes, scope, portal = _three_faces(accounts, repo, groups)
    _assert_faces_agree(hermes, scope, portal)
    assert Decimal(hermes.summary["total_liabilities_cny"]) == (
        Decimal("1000.00") * Decimal(USD_RATE) + Decimal("250000.37") * Decimal(EUR_RATE)
    )
    assert hermes.summary["sign_warnings"] == []


# -------------------------------------------------------------------
# 3. include_net_worth=false 排除
# -------------------------------------------------------------------

def test_include_net_worth_false_excluded_from_both_faces(repo, groups):
    accounts = [
        _acct("5105", "银行甲存款", "asset", "CNY", "1000.00"),
        _acct("5113", "迁移清算 · CNY", "asset", "CNY", "1000.00", include_net_worth=False),
        _acct("5110", "Broker A", "liabilities", "USD", "-500.00", include_net_worth=False),
    ]
    hermes, scope, portal = _three_faces(accounts, repo, groups)
    _assert_faces_agree(hermes, scope, portal)

    assert hermes.summary["total_assets_cny"] == "1000"
    assert hermes.summary["total_liabilities_cny"] == "0"
    assert hermes.summary["net_worth_cny"] == "1000"
    # ③ 计数逻辑不动：被排除账户仍如实报数。
    assert hermes.summary["account_stats"]["excluded_include_net_worth_false"] == 2
    assert portal["summary"]["included_account_count"] == 1
    displayed = {a["id"] for g in portal["groups"] for a in g["accounts"]}
    assert displayed == {"5105"}


@pytest.mark.parametrize("flag", [0, None], ids=["falsy-zero", "falsy-none"])
def test_falsy_include_net_worth_flag_excluded_on_both_faces(repo, groups, flag):
    """include_net_worth 为**非 bool 假值**（0 / None）时，三处谓词必须同判。

    规范谓词是 ``bool(attrs.get("include_net_worth", True))``（value_personal_scope
    与 FireflyClient.get_account_balances 都用它）。Hermes 面此前手写
    ``... is False``，对 0/None 判为「计入」：账户行里出现它、三总额里排除它，
    同一响应自相矛盾（实测 行相加 5100 vs 总额 100）。
    """
    accounts = [
        _acct("5105", "银行甲存款", "asset", "CNY", "100.00"),
        _acct("5113", "迁移清算 · CNY", "asset", "CNY", "5000.00", include_net_worth=flag),
    ]
    hermes, scope, portal = _three_faces(accounts, repo, groups)
    _assert_faces_agree(hermes, scope, portal)

    # 总额与展示行同源：被排除的账户既不进总额，也不出行。
    assert hermes.summary["total_assets_cny"] == "100"
    assert [(r.currency, r.amount) for r in hermes.sections[0].rows] == [("CNY", "100")]
    assert hermes.summary["account_stats"]["excluded_include_net_worth_false"] == 1
    displayed = {a["id"] for g in portal["groups"] for a in g["accounts"]}
    assert displayed == {"5105"}


# -------------------------------------------------------------------
# 4. 缺率 -> null（fail-closed，两侧同为 null，不得一侧伪造）
# -------------------------------------------------------------------

def test_missing_rate_nulls_totals_on_both_faces(repo, groups):
    accounts = [
        _acct("90006", "外币钱包", "asset", "HKD", "12000.25"),
        _acct("5105", "银行甲存款", "asset", "CNY", "100.00"),
        _acct("90001", "信用卡", "liabilities", "HKD", "-50.00"),
    ]
    hermes, scope, portal = _three_faces(accounts, repo, groups)
    _assert_faces_agree(hermes, scope, portal)

    assert hermes.fx_complete is False
    assert hermes.data_complete is False
    for hermes_key, base_key in _TOTAL_KEYS:
        assert hermes.summary[hermes_key] is None
        assert scope[base_key] is None
        assert portal["summary"][base_key] is None
    assert scope["missing_currencies"] == ["HKD"]
    assert hermes.summary["missing_currencies"] == ["HKD"]
    assert portal["missing_currencies"] == ["HKD"]
    # 三总额确实为 null 时，警示语才可以那么说（与 ISK 用例的行级措辞相对）。
    assert any("汇总总额为 null" in w for w in portal["warnings"])
    # 原币值始终保留。
    hkd_row = next(r for r in hermes.sections[0].rows if r.currency == "HKD")
    assert hkd_row.amount == "12000.25" and hkd_row.amount_base is None


def test_zero_aggregate_currency_without_rate_does_not_null_totals(repo, groups):
    """同币种非零账户互相抵成 0 且该币种缺率：不阻断总额（与 fx fail-closed 叙述一致）。

    记录本批次的裁决：总额来自逐币种聚合后的净额判断，行级折算仍为 null。
    """
    accounts = [
        _acct("90007", "多头", "asset", "ISK", "100.00"),
        _acct("90008", "空头", "asset", "ISK", "-100.00"),
        _acct("5105", "银行甲存款", "asset", "CNY", "500.00"),
    ]
    hermes, scope, portal = _three_faces(accounts, repo, groups)
    # 门户面的 fx_complete 仍按**账户行**严格（行级折算不出即为 false），
    # Hermes 面按**币种聚合**判定；本批次只统一三总额，该标志位差异保留并记录。
    _assert_faces_agree(hermes, scope, portal, check_fx_complete=False)

    assert hermes.fx_complete is True
    assert scope["fx_complete"] is True
    assert portal["fx_complete"] is False
    assert hermes.summary["net_worth_cny"] == "500"
    assert portal["summary"]["net_worth_base"] == "500"
    assert hermes.summary["zero_balance_missing_currencies"] == ["ISK"]
    isk_rows = [r for r in hermes.sections[0].rows if r.currency == "ISK"]
    assert isk_rows[0].amount_base is None

    # 门户面的警示语必须与**它自己的响应**一致：这里三总额为 500（非 null），
    # 因此只能陈述行级事实，不得声称汇总总额为 null（改前即为虚假告警）。
    fx_warnings = [w for w in portal["warnings"] if "汇率" in w]
    assert len(fx_warnings) == 1, portal["warnings"]
    assert "汇总总额为 null" not in fx_warnings[0]
    assert "汇总总额不受影响" in fx_warnings[0]
    # 标志位/总额的自洽：false 来自行级严格，故缺率币种的行必为 null、总额非 null。
    assert portal["summary"]["net_worth_base"] is not None
    isk_portal_rows = [
        a for g in portal["groups"] for a in g["accounts"] if a["currency"] == "ISK"
    ]
    assert len(isk_portal_rows) == 2
    assert all(a["balance_base"] is None for a in isk_portal_rows)


# -------------------------------------------------------------------
# 5. 聚合顺序残差：28 位精度下唯一可见的顺序敏感形态
# -------------------------------------------------------------------

def test_order_of_aggregation_is_a_single_point(repo, groups):
    """12 位小数汇率 x 8 位小数余额 x 40 个账户：乘积超出 Decimal 28 位精度。

    改前该形态下门户面「逐账户折算后求和」与统一聚合点「逐币种聚合后折算」
    相差 1E-16 CNY（实测，见 Batch 11 报告）；改后两侧同源，必须 exact equal。
    """
    balance = "1234567890.12345678"
    accounts = [
        _acct(f"9{i:04d}", f"USD 账户 {i}", "asset", "USD", balance) for i in range(40)
    ]
    repo.upsert_market("USD", "7.123456789012", AS_OF)
    hermes, scope, portal = _three_faces(accounts, repo, groups)
    _assert_faces_agree(hermes, scope, portal)
    # 28 位有效数字：证明该用例确实压在 Decimal 精度边界上（顺序敏感的前提）。
    assert hermes.summary["total_assets_cny"] == "351775640735.8463624928224361"


# -------------------------------------------------------------------
# 6. 端点级对账：两个门面确实吃同一账户集合（含 include_net_worth 过滤）
# -------------------------------------------------------------------

FF = "http://localhost:18080/api/v1"

EP_ASSETS = [
    {"id": "5105", "attributes": {
        "name": "银行甲存款", "type": "asset", "currency_code": "CNY",
        "current_balance": "100000.00", "active": True, "include_net_worth": True}},
    {"id": "5110", "attributes": {
        "name": "Broker A", "type": "asset", "currency_code": "USD",
        "current_balance": "12345.67", "active": True, "include_net_worth": True}},
    {"id": "5103", "attributes": {
        "name": "Bank A", "type": "asset", "currency_code": "USD",
        "current_balance": "987.65", "active": True, "include_net_worth": True}},
    {"id": "5104", "attributes": {
        "name": "Bank B", "type": "asset", "currency_code": "EUR",
        "current_balance": "10000.01", "active": True, "include_net_worth": True}},
    {"id": "5113", "attributes": {
        "name": "迁移清算 · CNY", "type": "asset", "currency_code": "CNY",
        "current_balance": "1000.00", "active": True, "include_net_worth": False}},
]

EP_LIABILITIES = [
    {"id": "5201", "attributes": {
        "name": "Card A", "type": "liabilities", "currency_code": "EUR",
        "current_balance": "-12345.67", "active": True, "include_net_worth": True}},
    {"id": "5210", "attributes": {
        "name": "银行甲消费贷", "type": "liabilities", "currency_code": "USD",
        "current_balance": "-1000.00", "active": True, "include_net_worth": True}},
]


@pytest.mark.skipif(not HAS_RESPX, reason="respx not installed")
class TestEndpointLevelReconciliation:
    """GET /v1/reports/balance-sheet（Hermes 面）vs /reports/personal-balance-sheet（门户面）。"""

    @pytest.fixture(autouse=True)
    def _setup(self):
        from finance_bridge.app.config import settings as cfg_settings
        from finance_bridge.app.state import reset_state
        reset_state()
        cfg_settings.bridge_internal_token = "test-token"
        cfg_settings.firefly_token = "test-ff-token"
        cfg_settings.firefly_api_url = FF
        cfg_settings.base_currency = "CNY"
        FXRateRepository().upsert_market("USD", USD_RATE, AS_OF)
        FXRateRepository().upsert_market("EUR", EUR_RATE, AS_OF)

    @pytest.fixture
    def client(self):
        from fastapi.testclient import TestClient

        from finance_bridge.app.main import app
        return TestClient(app)

    @respx.mock
    def test_both_faces_return_identical_net_worth(self, client):
        from httpx import Response
        headers = {"Authorization": "Bearer test-token"}
        for atype, payload in (("asset", EP_ASSETS), ("liabilities", EP_LIABILITIES)):
            respx.get(f"{FF}/accounts?type={atype}&page=1&limit=50&date={AS_OF}").mock(
                return_value=Response(200, json={
                    "data": payload,
                    "meta": {"pagination": {"total_pages": 1}},
                }))

        hermes = client.get(f"/v1/reports/balance-sheet?as_of={AS_OF}", headers=headers)
        portal = client.get(f"/v1/reports/personal-balance-sheet?as_of={AS_OF}", headers=headers)
        assert hermes.status_code == 200, hermes.text
        assert portal.status_code == 200, portal.text

        h_summary = hermes.json()["summary"]
        p_summary = portal.json()["summary"]
        for hermes_key, base_key in _TOTAL_KEYS:
            assert h_summary[hermes_key] == p_summary[base_key], hermes_key
        # 两个门面都带 include_net_worth_only=True 取数，126（1000.00）在 client 层
        # 已被滤掉，故两侧读到同一账户集合，且总额与单元层用例逐字相同。
        assert h_summary["net_worth_cny"] == "169380.1700079514"
        assert h_summary["account_stats"]["excluded_include_net_worth_false"] == 0
        assert p_summary["included_account_count"] == 6  # 4 资产 + 2 负债（126 已被 client 滤除）
