"""Feishu presentation builders.

All display amounts are pre-formatted here by Bridge (plan §11). Hermes
must pass title/summary/table/footer verbatim to send_feishu_card /
send_feishu_table and never recompute percentages or totals.
Cards show at most TOP_ROWS rows; never account-level dumps.
"""
from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Any

from finance_bridge.app.reporting.contracts import (
    Presentation,
    format_amount,
    generated_now,
)

if TYPE_CHECKING:
    from finance_bridge.app.reporting.contracts import ReportSection, ReportSectionRow

TOP_ROWS = 10
UNAVAILABLE = "不可用（缺汇率）"


def _fmt_cny(text: str | None) -> str:
    if text is None:
        return UNAVAILABLE
    return format_amount(Decimal(text), "CNY")


def _footer(parts: list[str], warnings: list[str]) -> str:
    lines = [" · ".join(p for p in parts if p)]
    if warnings:
        lines.append("⚠️ " + "；".join(warnings[:5]))
    return "\n".join(lines)


def build_balance_sheet_presentation(
    as_of: str,
    summary: dict[str, Any],
    sections: list[ReportSection],
    fx_complete: bool,
    warnings: list[str],
) -> Presentation:
    title = f"个人资产负债快照 · {as_of}"
    if not fx_complete:
        title += "（数据不完整）"

    total_assets = _fmt_cny(summary.get("total_assets_cny"))
    total_liabilities = _fmt_cny(summary.get("total_liabilities_cny"))
    net_worth = _fmt_cny(summary.get("net_worth_cny"))
    fx_text = "完整" if fx_complete else f"缺失：{', '.join(summary.get('missing_currencies', []))}"
    summary_md = (
        f"**总资产：**{total_assets}\n"
        f"**总负债：**{total_liabilities}\n"
        f"**净资产：**{net_worth}\n"
        f"**汇率完整性：**{fx_text}"
    )

    total_base = (
        Decimal(summary["total_assets_cny"])
        if fx_complete and summary.get("total_assets_cny") else None
    )
    # P5-R: TOP_ROWS caps the whole card (assets + liabilities combined),
    # not each section separately.
    table_rows: list[list[str]] = []
    for section in sections:
        for row in section.rows:
            if len(table_rows) >= TOP_ROWS:
                break
            converted = _fmt_cny(row.amount_base) if row.amount_base is not None else UNAVAILABLE
            share = "—"
            if (section.key == "assets" and total_base and total_base > 0
                    and row.amount_base is not None):
                share = f"{(Decimal(row.amount_base) / total_base * 100).quantize(Decimal('0.1'))}%"
            table_rows.append([
                f"{section.title} · {row.label}",
                format_amount(Decimal(row.amount), row.currency),
                converted,
                share,
            ])
        if len(table_rows) >= TOP_ROWS:
            break

    return Presentation(
        title=title,
        template="blue" if fx_complete else "orange",
        summary_markdown=summary_md,
        table_headers=["类别", "原币", "CNY 折算", "占比"],
        table_rows=table_rows,
        footer_markdown=_footer(
            ["来源：firefly_live", f"余额日期：{as_of}", "汇率口径：期末汇率",
             f"生成时间：{generated_now()}"],
            warnings,
        ),
    )


def build_income_statement_presentation(
    start_date: str,
    end_date: str,
    view: str,
    summary: dict[str, Any],
    sections: list[ReportSection],
    fx_complete: bool,
    warnings: list[str],
) -> Presentation:
    title = f"期间收支 · {start_date} 至 {end_date}"
    if not fx_complete:
        title += "（数据不完整）"

    income = _fmt_cny(summary.get("total_income_cny"))
    expenses = _fmt_cny(summary.get("total_expenses_cny"))
    net = _fmt_cny(summary.get("net_result_cny"))
    savings = summary.get("savings_rate_pct")
    summary_md = (
        f"**收入：**{income}\n"
        f"**费用：**{expenses}\n"
        f"**净结余：**{net}\n"
        f"**储蓄率：**{savings + '%' if savings is not None else '—'}"
    )

    total_expenses = (
        Decimal(summary["total_expenses_cny"])
        if fx_complete and summary.get("total_expenses_cny") else None
    )
    # P5-R: TOP_ROWS caps the whole card (income + expenses combined).
    table_rows: list[list[str]] = []
    for section in sections:
        if section.key not in ("income", "expenses"):
            continue
        for row in section.rows:
            if len(table_rows) >= TOP_ROWS:
                break
            share = "—"
            if (section.key == "expenses" and total_expenses and total_expenses > 0
                    and row.amount_base is not None):
                share = f"{(Decimal(row.amount_base) / total_expenses * 100).quantize(Decimal('0.1'))}%"
            table_rows.append([
                f"{section.title} · {row.label}",
                format_amount(Decimal(row.amount), row.currency),
                share,
                str(row.count or 0),
            ])
        if len(table_rows) >= TOP_ROWS:
            break

    unclassified = summary.get("unclassified_count", 0)
    return Presentation(
        title=title,
        template="blue" if fx_complete else "orange",
        summary_markdown=summary_md,
        table_headers=["科目", "金额", "占比", "笔数"],
        table_rows=table_rows,
        footer_markdown=_footer(
            [f"口径：{'管理口径' if view == 'management' else '原生口径'}",
             "汇率方法：交易日汇率",
             f"未分类：{unclassified} 笔",
             f"生成时间：{generated_now()}"],
            warnings,
        ),
    )


def build_expense_breakdown_presentation(
    period: dict[str, str],
    compare_period: dict[str, str] | None,
    rows: list[ReportSectionRow],
    summary: dict[str, Any],
    fx_complete: bool,
    warnings: list[str],
) -> Presentation:
    period_text = f"{period['start_date']} 至 {period['end_date']}"
    if compare_period:
        title = (f"费用分析 · {period_text} vs "
                 f"{compare_period['start_date']} 至 {compare_period['end_date']}")
    else:
        title = f"费用分析 · {period_text}"
    if not fx_complete:
        title += "（数据不完整）"

    table_rows: list[list[str]] = []
    for row in rows[:TOP_ROWS]:
        current = format_amount(Decimal(row.amount), row.currency)
        compare_amount = row.extra.get("compare_amount")
        compare_text = (
            format_amount(Decimal(compare_amount), row.currency)
            if compare_amount is not None else "—"
        )
        change = row.extra.get("change")
        change_text = (
            format_amount(Decimal(change), row.currency) if change is not None else "—"
        )
        if row.extra.get("new_spend"):
            pct_text = "新增支出"
        elif row.extra.get("change_pct") is not None:
            pct_text = f"{row.extra['change_pct']}%"
        else:
            pct_text = "—"
        table_rows.append([row.label, current, compare_text, change_text, pct_text])

    total = summary.get("total_expenses_cny")
    summary_md = f"**本期费用合计：**{_fmt_cny(total)}"
    if summary.get("compare_total_expenses_cny") is not None:
        summary_md += f"\n**比较期费用合计：**{_fmt_cny(summary['compare_total_expenses_cny'])}"

    return Presentation(
        title=title,
        template="blue" if fx_complete else "orange",
        summary_markdown=summary_md,
        table_headers=["科目", "本期", "上期", "变化额", "变化率"],
        table_rows=table_rows,
        footer_markdown=_footer(
            [f"Top {summary.get('top_n', 10)}",
             f"口径：{'管理口径' if summary.get('accounting_view') == 'management' else '原生口径'}",
             f"生成时间：{generated_now()}"],
            warnings,
        ),
    )
