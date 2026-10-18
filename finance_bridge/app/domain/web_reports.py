"""report-web 专用响应模型（与 Hermes/飞书 presenter 使用的模型隔离）。

设计要点（实施文档 §5.1）：
- 不复用现有 ReportType Literal，避免扩大其语义；
- 金额一律 Decimal 字符串 (str)，与 ReportEnvelope.decimal_text 对齐，绝不用二进制浮点；
- 白名单 float 字段（仅限比率/百分比/汇率，禁止金额字段使用 float）：
  percentage, deviation, deviation_percentage, change_rate, fx_contribution_percentage, start_rate, end_rate;
- 汇率不完整时 balance_base / 汇总总额为 null，原币余额始终保留。
"""
from __future__ import annotations

from pydantic import BaseModel, Field

SCHEMA_VERSION = "1.0"


class WebAccountBalanceRow(BaseModel):
    id: str
    name: str
    type: str
    currency: str
    balance: str
    balance_base: str | None
    active: bool
    account_role: str | None
    include_net_worth: bool
    group: str | None
    group_title: str | None
    fx_rate_date: str | None
    fx_source: str | None


class WebAccountBalancesResponse(BaseModel):
    base_currency: str
    as_of: str
    fx_complete: bool
    missing_currencies: list[str] = Field(default_factory=list)
    accounts: list[WebAccountBalanceRow] = Field(default_factory=list)


class WebAccountRow(BaseModel):
    """资产负债表中单个账户的行。"""

    id: str
    name: str
    currency: str
    balance_native: str                     # 原币余额（负债为展示正数）
    balance_base: str | None = None         # 基础币种折算（缺失汇率时为 null）
    active: bool = True
    include_net_worth: bool = True


class WebAccountGroup(BaseModel):
    """一个业务分组（资产或负债）。"""

    key: str
    title: str
    side: str                               # "asset" | "liability"
    subtotal_base: str | None = None
    accounts: list[WebAccountRow] = Field(default_factory=list)


class BalanceSheetSummary(BaseModel):
    """汇总行：FX 不完整时资产/负债/净资产均为 null。"""

    total_assets_base: str | None = None
    total_liabilities_base: str | None = None
    net_worth_base: str | None = None
    included_account_count: int = 0
    pending_mapping_count: int = 0


class PersonalBalanceSheetResponse(BaseModel):
    """GET /v1/reports/personal-balance-sheet 响应。"""

    schema_version: str = SCHEMA_VERSION
    source: str = "firefly_live"
    generated_at: str
    base_currency: str
    balance_as_of: str
    fx_complete: bool
    missing_currencies: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    summary: BalanceSheetSummary
    groups: list[WebAccountGroup] = Field(default_factory=list)


class NetWorthTrendPoint(BaseModel):
    """趋势曲线上的一个点；单点汇率不完整时总额为 null。"""

    date: str
    total_assets_base: str | None = None
    total_liabilities_base: str | None = None
    net_worth_base: str | None = None
    fx_complete: bool = True
    missing_currencies: list[str] = Field(default_factory=list)


class NetWorthTrendResponse(BaseModel):
    """GET /v1/reports/net-worth-trend 响应。"""

    schema_version: str = SCHEMA_VERSION
    base_currency: str
    as_of: str
    months: int
    points: list[NetWorthTrendPoint] = Field(default_factory=list)


class FxAttributionCurrency(BaseModel):
    """单币种的储蓄/汇率贡献拆解。"""

    currency: str
    start_balance: str
    end_balance: str
    start_rate: float
    end_rate: float
    savings_contribution_cny: str
    fx_contribution_cny: str
    net_change_cny: str


class FxAttributionResponse(BaseModel):
    """GET /v1/reports/fx-attribution 响应。"""

    schema_version: str = SCHEMA_VERSION
    period_from: str
    period_to: str
    total_net_worth_change_cny: str
    total_savings_contribution_cny: str
    total_fx_contribution_cny: str
    fx_contribution_percentage: float
    by_currency: list[FxAttributionCurrency] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class SpendingTrendRow(BaseModel):
    """单个支出类别：本月 vs 历史均值（MTD 同期、交易日汇率折算 CNY）。

    fx_complete=False（任一笔非零交易缺汇率）时金额与偏差一律为 None，anomaly=False。
    """

    category: str
    current_month_amount: str | None = None
    historical_monthly_average: str | None = None
    deviation_percentage: float | None = None
    fx_complete: bool = True
    missing_currencies: list[str] = Field(default_factory=list)
    anomaly: bool = False


class SpendingTrendsResponse(BaseModel):
    """GET /v1/reports/web/spending-trends 响应（v2：as_of / MTD / 行级汇率完整性）。"""

    schema_version: str = SCHEMA_VERSION
    as_of: str
    current_month: str
    comparison_window_months: int
    base_currency: str
    fx_complete: bool = True
    missing_currencies: list[str] = Field(default_factory=list)
    categories_count: int = 0
    anomalies_count: int = 0
    trends: list[SpendingTrendRow] = Field(default_factory=list)


class CurrencyExposureRow(BaseModel):
    """单币种敞口。缺汇率时 cny_value/percentage 为 None。"""

    currency: str
    balance: str
    cny_value: str | None = None
    percentage: float | None = None


class CurrencyExposureResponse(BaseModel):
    """GET /v1/reports/currency-exposure 响应。fx_complete=False 时 total_net_worth_cny 为 None。"""

    schema_version: str = SCHEMA_VERSION
    base_currency: str
    total_net_worth_cny: str | None = None
    fx_rates_date: str
    fx_complete: bool = True
    missing_currencies: list[str] = Field(default_factory=list)
    exposures: list[CurrencyExposureRow] = Field(default_factory=list)


class TransactionRow(BaseModel):
    """单笔交易（journal 级）。amount_native 恒为正数，方向由 type 表达。"""

    date: str
    type: str
    description: str
    category: str
    source: str
    destination: str
    amount_native: str
    currency: str
    amount_base: str | None = None
    fx_exact: bool = True
    tags: list[str] = Field(default_factory=list)
    journal_id: str


class TransactionsResponse(BaseModel):
    """GET /v1/reports/transactions 响应（服务端分页）。

    fx_notes：区分两类汇率口径说明——
      1. 有回填汇率但非当日精确（fx_exact=False 且 amount_base 非 None）；
      2. 交易日前完全无汇率（amount_base is None，未折算）。
    """

    schema_version: str = SCHEMA_VERSION
    period_from: str
    period_to: str
    total: int
    offset: int
    limit: int
    rows: list[TransactionRow] = Field(default_factory=list)
    fx_notes: list[str] = Field(default_factory=list)


class AnomalyRow(BaseModel):
    """单条异常。severity: warning | critical。

    P1 修复：`message` 不再拼入金额数字；结构化金额字段供前端用 `Amount` 渲染（参与遮蔽）。
    id 为确定性稳定 ID（spec A.1），严禁 UUID/random；category 明确分类名（无则 null），
    前端严禁正则解析 message。"""
    id: str
    source: str
    severity: str
    message: str
    category: str | None = None
    amount: str | None = None
    currency: str | None = None


class AnomaliesResponse(BaseModel):
    """GET /v1/reports/web/anomalies 响应。"""

    schema_version: str = SCHEMA_VERSION
    checked_at: str
    count: int
    anomalies: list[AnomalyRow] = Field(default_factory=list)
