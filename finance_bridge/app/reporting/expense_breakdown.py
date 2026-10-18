"""Expense breakdown (费用分析表) — Top N with period comparison.

Policy (plan §8.3): per-category current amount, comparison amount,
change, change rate, share of current expenses, count, FX status.
Division-by-zero rules: compare=0 & current>0 ⇒ change_pct=null with
new_spend=true; both zero ⇒ excluded. Never Infinity/NaN.
"""
from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from finance_bridge.app.reporting.contracts import (
    ReportEnvelope,
    ReportSection,
    ReportSectionRow,
    decimal_text,
    new_report_id,
)
from finance_bridge.app.reporting.income_statement import compute_income_statement
from finance_bridge.app.reporting.presentation import build_expense_breakdown_presentation
from finance_bridge.app.storage.fx_rates import FXRateRepository

BASE = "CNY"


def _expense_totals(envelope: ReportEnvelope) -> dict[tuple[str, str], dict]:
    """Extract (category, currency) → {amount, amount_base, count} from the
    expenses section of an income-statement envelope."""
    result: dict[tuple[str, str], dict] = {}
    for section in envelope.sections:
        if section.key != "expenses":
            continue
        for row in section.rows:
            result[(row.label, row.currency)] = {
                "amount": Decimal(row.amount),
                "amount_base": Decimal(row.amount_base) if row.amount_base is not None else None,
                "count": row.count or 0,
            }
    return result


def compute_expense_breakdown(
    current_groups: list[dict],
    start_date: str,
    end_date: str,
    fx_repository: FXRateRepository,
    compare_groups: list[dict] | None = None,
    compare_start_date: str | None = None,
    compare_end_date: str | None = None,
    top_n: int = 10,
    accounting_view: str = "management",
) -> ReportEnvelope:
    """Compute Top-N expense analysis, optionally against a comparison period."""
    top_n = max(1, min(int(top_n), 20))

    current = compute_income_statement(
        current_groups, start_date, end_date, accounting_view, fx_repository)
    has_compare = compare_groups is not None and compare_start_date and compare_end_date
    compare = None
    if has_compare:
        compare = compute_income_statement(
            compare_groups, compare_start_date, compare_end_date,  # type: ignore[arg-type]
            accounting_view, fx_repository)

    warnings = list(current.warnings)
    if compare:
        warnings.extend(f"比较期：{w}" for w in compare.warnings)
    fx_complete = current.fx_complete and (compare.fx_complete if compare else True)

    cur_map = _expense_totals(current)
    cmp_map = _expense_totals(compare) if compare else {}

    # Share denominator: total current expenses in CNY (only when complete).
    total_expenses_base: Decimal | None = None
    if current.fx_complete and current.summary.get("total_expenses_cny") is not None:
        total_expenses_base = Decimal(current.summary["total_expenses_cny"])

    entries: list[dict] = []
    for key in sorted(set(cur_map) | set(cmp_map)):
        category, currency = key
        cur = cur_map.get(key)
        cmp_e = cmp_map.get(key)
        cur_amount = cur["amount"] if cur else Decimal(0)
        cmp_amount = cmp_e["amount"] if cmp_e else Decimal(0)
        if cur_amount == 0 and cmp_amount == 0:
            continue  # both periods zero → not in Top N

        change = cur_amount - cmp_amount
        change_pct: str | None = None
        new_spend = False
        if cmp_amount != 0:
            change_pct = str((change / cmp_amount * 100).quantize(Decimal("0.1")))
        elif cur_amount > 0:
            new_spend = True  # change rate undefined; never Infinity

        cur_base = cur["amount_base"] if cur else None
        share_pct: str | None = None
        if (cur_base is not None and total_expenses_base
                and total_expenses_base > 0):
            share_pct = str((cur_base / total_expenses_base * 100).quantize(Decimal("0.1")))

        entries.append({
            "category": category,
            "currency": currency,
            "current_amount": cur_amount,
            "current_amount_base": cur_base,
            "compare_amount": cmp_amount if has_compare else None,
            "change": change if has_compare else None,
            "change_pct": change_pct if has_compare else None,
            "new_spend": new_spend if has_compare else False,
            "share_pct": share_pct,
            "count": cur["count"] if cur else 0,
            "fx_converted": cur_base is not None,
        })

    # P5-R ranking policy: a global Top N is only meaningful in one unit.
    # With complete FX for the current period, rank by CNY value. Without
    # it, never compare raw amounts across currencies — rank per currency
    # instead and say so explicitly.
    global_ranking_available = bool(current.fx_complete)
    if global_ranking_available:
        entries.sort(key=lambda e: -(e["current_amount_base"]
                                     if e["current_amount_base"] is not None
                                     else Decimal(0)))
        top_entries = entries[:top_n]
    else:
        by_currency: dict[str, list[dict]] = defaultdict(list)
        for e in entries:
            by_currency[e["currency"]].append(e)
        top_entries = []
        for currency in sorted(by_currency):
            group = sorted(by_currency[currency],
                           key=lambda e: -abs(e["current_amount"]))
            top_entries.extend(group[:top_n])
        warnings.append("缺少汇率，无法生成全局 Top N；已按币种分别排名")

    rows = [
        ReportSectionRow(
            label=e["category"], currency=e["currency"],
            amount=decimal_text(e["current_amount"]),
            amount_base=decimal_text(e["current_amount_base"]) if e["current_amount_base"] is not None else None,
            count=e["count"],
            extra={
                "compare_amount": decimal_text(e["compare_amount"]) if e["compare_amount"] is not None else None,
                "change": decimal_text(e["change"]) if e["change"] is not None else None,
                "change_pct": e["change_pct"],
                "new_spend": e["new_spend"],
                "share_pct": e["share_pct"],
                "fx_converted": e["fx_converted"],
            },
        )
        for e in top_entries
    ]

    period = {"start_date": start_date, "end_date": end_date}
    compare_period = (
        {"start_date": compare_start_date, "end_date": compare_end_date}
        if has_compare else None
    )

    summary = {
        "accounting_view": current.summary["accounting_view"],
        "top_n": top_n,
        "global_ranking_available": global_ranking_available,
        "ranking_basis": "cny" if global_ranking_available else "per_currency",
        "total_expenses_cny": current.summary.get("total_expenses_cny"),
        "compare_period": compare_period,
        "compare_total_expenses_cny": compare.summary.get("total_expenses_cny") if compare else None,
        "candidate_categories": len(entries),
        "unclassified_count": current.summary.get("unclassified_count", 0),
        "missing_currencies": sorted(set(
            current.summary.get("missing_currencies", [])
            + (compare.summary.get("missing_currencies", []) if compare else [])
        )),
    }

    return ReportEnvelope(
        report_id=new_report_id("expense_breakdown"),
        report_type="expense_breakdown",
        base_currency=BASE,
        period=period,
        accounting_view=current.summary["accounting_view"],
        fx_method="transaction_date",
        fx_complete=fx_complete,
        data_complete=fx_complete,
        warnings=warnings,
        summary=summary,
        sections=[ReportSection(key="top_expenses", title="前 N 大费用", rows=rows)],
        presentation=build_expense_breakdown_presentation(
            period=period, compare_period=compare_period,
            rows=rows, summary=summary,
            fx_complete=fx_complete, warnings=warnings,
        ),
    )
