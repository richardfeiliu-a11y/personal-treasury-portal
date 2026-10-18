"""Balance sheet (资产负债快照) computation service.

Policy (docs/个人财务只读报表-v1-开发实施计划.md §8.1):
- Balances come from Firefly with an explicit ``date`` parameter, so a
  historical as_of really is a historical balance, not current balance
  plus historical FX.
- 三总额（总资产/总负债/净资产）由门户面唯一聚合点
  ``personal_balance_sheet.value_personal_scope`` 产出（CALC-01 / Batch 11）：
  逐账户按币种聚合后按币种折算，负债逐账户取绝对值（毛额，非同币种净额），
  净资产 = 资产合计 - 负债合计。展示层仍按原逻辑逐币种出行，负债行转正数显示；
  同币种内正负并存的负债，行内为净额、总额为毛额，差值由 ``sign_warnings`` 报出。
- ``include_net_worth=false`` accounts are excluded from totals but the
  filter count is reported.
- Inactive accounts are kept when their balance is non-zero; zero-balance
  inactive accounts are dropped (count reported).
- Closing-rate FX via FXRateRepository; missing FX for a non-zero
  currency ⇒ fx_complete=False and null CNY totals (fail closed).
"""
from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from finance_bridge.app.config import settings
from finance_bridge.app.reporting.contracts import (
    ReportEnvelope,
    ReportSection,
    ReportSectionRow,
    decimal_text,
    new_report_id,
)
from finance_bridge.app.reporting.personal_balance_sheet import value_personal_scope
from finance_bridge.app.reporting.presentation import build_balance_sheet_presentation
from finance_bridge.app.storage.fx_rates import FXRateRepository


def _scope_total(value: str | None) -> Decimal | None:
    """统一聚合点返回 Decimal 文本（缺率时为 None）。"""
    return None if value is None else Decimal(value)


def compute_balance_sheet(
    accounts: list[dict],
    as_of: str,
    fx_repository: FXRateRepository,
) -> ReportEnvelope:
    """Compute the balance-sheet report from Firefly account payloads.

    ``accounts`` must be the Firefly /accounts response data (asset +
    liabilities types) already fetched with ``date=as_of``.
    """
    # 记账本位币的唯一来源是 settings.base_currency（ARCH-03 / Batch 13）：本模块
    # 原先自带 `BASE = "CNY"`，与 config 里的默认值构成第二份事实。折算逻辑一字未动，
    # 默认配置（CNY）下输出逐字不变。唯一的非 CNY 强制拒绝只在 `api/reports.py` 的
    # account-balances 端点（503），本模块所在的报表面在非 CNY 本位下属于「不支持但
    # 未被强制拒绝」；切换本位币需同步处理 FX 表以 CNY 为基准的契约
    # （`storage/fx_rates.py:effective_rate`）。
    base = settings.base_currency.upper()
    warnings: list[str] = []
    sign_warnings: list[str] = []

    # currency -> 带符号余额合计（负债侧为带符号净额，只服务展示行）；
    # 每币种的账户计数分别存在 asset_counts / liability_counts。
    asset_by_currency: dict[str, Decimal] = defaultdict(Decimal)
    liability_by_currency: dict[str, Decimal] = defaultdict(Decimal)
    asset_counts: dict[str, int] = defaultdict(int)
    liability_counts: dict[str, int] = defaultdict(int)

    excluded_net_worth = 0
    skipped_inactive_zero = 0
    kept_inactive_nonzero = 0

    for account in accounts:
        attrs = account.get("attributes", {})
        acct_type = attrs.get("type", "")
        if acct_type not in ("asset", "liabilities", "liability"):
            # Balance sheet never reads expense/revenue accounts.
            continue
        currency = (attrs.get("currency_code") or base).upper()
        try:
            balance = Decimal(attrs.get("current_balance", "0"))
        except Exception:
            warnings.append(f"账户 {account.get('id')} 余额无法解析，已跳过")
            continue

        active = attrs.get("active", True)
        if not active:
            if balance == 0:
                skipped_inactive_zero += 1
                continue
            kept_inactive_nonzero += 1

        # 规范谓词（与 value_personal_scope / FireflyClient 同源）：`is False` 会把
        # 0 / None 这类假值判成「计入」，导致展示行与总额（走聚合点）自相矛盾。
        if not bool(attrs.get("include_net_worth", True)):
            excluded_net_worth += 1
            continue

        if acct_type == "asset":
            asset_by_currency[currency] += balance
            asset_counts[currency] += 1
        else:
            if balance > 0:
                sign_warnings.append(
                    f"负债账户 {attrs.get('name', account.get('id'))} 出现异常正余额"
                )
            liability_by_currency[currency] += balance
            liability_counts[currency] += 1

    # ---------------------------------------------------------------
    # Closing-rate valuation (fail closed on missing non-zero FX)
    # ---------------------------------------------------------------
    all_currencies = sorted(set(asset_by_currency) | set(liability_by_currency))
    rates: dict[str, Decimal] = {}
    missing: list[str] = []
    zero_missing: list[str] = []
    for currency in all_currencies:
        rate = fx_repository.effective_rate(currency, as_of)
        nonzero = (
            asset_by_currency.get(currency, Decimal(0)) != 0
            or liability_by_currency.get(currency, Decimal(0)) != 0
        )
        if rate:
            rates[currency] = Decimal(str(rate["rate"]))
        elif nonzero:
            missing.append(currency)
        else:
            zero_missing.append(currency)

    fx_complete = not missing
    if missing:
        warnings.append(f"缺少汇率（非零余额币种）：{', '.join(missing)}；{base} 总数不可用")
    if zero_missing:
        warnings.append(f"缺少汇率（零余额币种，不阻断）：{', '.join(zero_missing)}")
    warnings.extend(sign_warnings)

    def _convert(value: Decimal, currency: str) -> Decimal | None:
        if currency in rates:
            return value * rates[currency]
        return None

    def _rows(
        by_currency: dict[str, Decimal], counts: dict[str, int], display_abs: bool
    ) -> list[ReportSectionRow]:
        rows = []
        for currency in sorted(by_currency):
            signed = by_currency[currency]
            # P5-R: displayed amounts (original AND CNY) share one sign
            # convention — liabilities positive. Signed values stay in
            # `extra` for control-figure reconciliation only.
            display = -signed if (display_abs and signed < 0) else signed
            converted_display = _convert(display, currency)
            converted_signed = _convert(signed, currency)
            rows.append(ReportSectionRow(
                label=currency,
                currency=currency,
                amount=decimal_text(display),
                amount_base=decimal_text(converted_display) if converted_display is not None else None,
                count=counts[currency],
                extra={
                    "signed_amount": decimal_text(signed),
                    "signed_amount_base": decimal_text(converted_signed) if converted_signed is not None else None,
                },
            ))
        return rows

    # ------------------------------------------------------------------
    # 三总额：统一聚合点（CALC-01 / Batch 11）
    # 语义决策采用门户面口径——「逐账户按币种聚合后按币种折算」，负债逐账户取
    # 绝对值（毛额）。上方 asset_by_currency / liability_by_currency 与 rates
    # 只服务展示行与 fx/汇率元数据，不再参与总额计算，避免两套顺序各算一次。
    # 账户集合权威源：两个门面的 api 层用同一次查询
    # （FireflyClient.get_account_balances(["asset","liabilities"],
    #   date=as_of, include_net_worth_only=True)），因此这里把**上游原始
    # accounts 原样**交给 value_personal_scope，由它自身的 type /
    # include_net_worth 过滤裁决，而不是复用上面过滤后的展示桶。
    # 缺率时聚合点返回 None：三总额一并 fail closed 为 null。
    # ------------------------------------------------------------------
    scope_totals = value_personal_scope(accounts, as_of, base, fx_repository)
    total_assets_base = _scope_total(scope_totals["total_assets_base"])
    total_liabilities_base = _scope_total(scope_totals["total_liabilities_base"])
    net_worth_base = _scope_total(scope_totals["net_worth_base"])

    sections = [
        ReportSection(
            key="assets", title="资产",
            rows=_rows(asset_by_currency, asset_counts, display_abs=False),
            subtotal_base=decimal_text(total_assets_base) if total_assets_base is not None else None,
        ),
        ReportSection(
            key="liabilities", title="负债",
            # 行是「同币种带符号净额转正展示」，subtotal_base 来自聚合点的「逐账户
            # 绝对值毛额」：同币种正负并存时两者本就不等，差额由 sign_warnings 报出。
            rows=_rows(liability_by_currency, liability_counts, display_abs=True),
            subtotal_base=decimal_text(total_liabilities_base) if total_liabilities_base is not None else None,
        ),
    ]

    summary = {
        "total_assets_cny": decimal_text(total_assets_base) if total_assets_base is not None else None,
        # Display convention: liabilities positive in summary.
        "total_liabilities_cny": decimal_text(total_liabilities_base) if total_liabilities_base is not None else None,
        "net_worth_cny": decimal_text(net_worth_base) if net_worth_base is not None else None,
        "currency_count": len(all_currencies),
        "account_stats": {
            "excluded_include_net_worth_false": excluded_net_worth,
            "skipped_inactive_zero_balance": skipped_inactive_zero,
            "kept_inactive_nonzero_balance": kept_inactive_nonzero,
        },
        "sign_warnings": sign_warnings,
        "missing_currencies": missing,
        "zero_balance_missing_currencies": zero_missing,
        "rates_used": {c: decimal_text(r) for c, r in rates.items()},
    }

    envelope = ReportEnvelope(
        report_id=new_report_id("balance_sheet"),
        report_type="balance_sheet",
        base_currency=base,
        balance_as_of=as_of,
        period=None,
        accounting_view="management",
        fx_method="closing_rate",
        fx_complete=fx_complete,
        data_complete=fx_complete,
        warnings=warnings,
        summary=summary,
        sections=sections,
        presentation=build_balance_sheet_presentation(
            as_of=as_of, summary=summary, sections=sections,
            fx_complete=fx_complete, warnings=warnings,
        ),
    )
    return envelope
