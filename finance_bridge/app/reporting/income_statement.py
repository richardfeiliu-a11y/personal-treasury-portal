"""Income statement (期间收支表) computation service.

Policy (plan §8.2):
- Two views: ``native`` (reconciles to Firefly's raw P&L) and
  ``management`` (excludes migration/adjustments; refunds reduce
  expenses; income reversals reduce income).
- Classification priority is fixed: expense/revenue account name first,
  then historical category_name, then 未分类. Transaction descriptions
  are never silently promoted to a formal category.
- Flow FX: fx_method=transaction_date, using the effective rate at (or
  nearest before) each journal date. Missing FX for any non-zero foreign
  journal ⇒ fail closed (null CNY totals, per-currency figures kept).
- Report requests never trigger FX backfill.
"""
from __future__ import annotations

from collections import defaultdict
from decimal import Decimal
from typing import Any

from finance_bridge.app.reporting.contracts import (
    ReportEnvelope,
    ReportSection,
    ReportSectionRow,
    decimal_text,
    new_report_id,
)
from finance_bridge.app.reporting.presentation import build_income_statement_presentation
from finance_bridge.app.storage.fx_rates import FXRateRepository

BASE = "CNY"
UNCLASSIFIED = "未分类"

# Tag → management-view treatment (never guessed from account names)
MIGRATION_TAGS = frozenset({"migration", "migration-opening-balance", "迁移调账", "迁移期末校准"})
ADJUSTMENT_TAGS = frozenset({"manual-reconciliation", "fx-source-only", "no-historical-rate"})
REFUND_TAG = "refund"
INCOME_REVERSAL_TAG = "income-reversal"

_FINANCIAL_KINDS = ("asset", "liability")


def _account_kind(type_name: str | None) -> str | None:
    """Map a Firefly account type string to a coarse kind.

    Firefly journal-level types include e.g. 'Asset account',
    'Expense account', 'Revenue account', 'Loan', 'Debt', 'Mortgage',
    'Cash account'. Unknown/absent types return None.
    """
    t = (type_name or "").lower()
    if not t:
        return None
    if "expense" in t:
        return "expense"
    if "revenue" in t:
        return "revenue"
    if "asset" in t or "cash" in t:
        return "asset"
    if any(k in t for k in ("liabilit", "loan", "debt", "mortgage", "credit card")):
        return "liability"
    return None


def iter_journals(transaction_groups: list[dict]) -> list[dict[str, Any]]:
    """Flatten Firefly v6 transaction groups into journal-level dicts."""
    journals: list[dict[str, Any]] = []
    for group in transaction_groups:
        attrs = group.get("attributes", {})
        entries = attrs.get("transactions") or []
        if not isinstance(entries, list):
            continue
        for journal in entries:
            if isinstance(journal, dict):
                journals.append(journal)
    return journals


def classify_journal(journal: dict) -> dict[str, Any]:
    """Deterministic classification of one journal entry.

    Returns kind ('expense'|'income'|'transfer'|'skip'), the management
    special bucket (None|'migration'|'adjustment'|'refund'|'income_reversal'),
    the category key with its provenance, currency, amount and date.
    """
    journal_type = journal.get("type", "")
    tags = journal.get("tags") or []
    if isinstance(tags, list):
        tags = [str(t).lower().strip() for t in tags]
    else:
        tags = []
    external_id = (journal.get("external_id") or "").lower()

    special: str | None = None
    if any(t in MIGRATION_TAGS for t in tags) or external_id.startswith("migration-"):
        special = "migration"
    elif any(t in ADJUSTMENT_TAGS for t in tags):
        special = "adjustment"
    elif REFUND_TAG in tags:
        special = "refund"
    elif INCOME_REVERSAL_TAG in tags:
        special = "income_reversal"

    if journal_type == "transfer":
        return {"kind": "transfer", "special": special}

    # P5-R: the journal type alone is not sufficient. When BOTH sides are
    # financial accounts (asset/liability) the movement is an account
    # transfer — e.g. credit-card repayment (asset→liability withdrawal)
    # or a credit refund arriving (liability→asset deposit) — and must be
    # excluded from P&L in every view.
    src_kind = _account_kind(journal.get("source_type"))
    dst_kind = _account_kind(journal.get("destination_type"))
    if (journal_type in ("withdrawal", "deposit")
            and src_kind in _FINANCIAL_KINDS and dst_kind in _FINANCIAL_KINDS):
        return {"kind": "account_transfer", "special": special}

    if journal_type == "withdrawal":
        kind = "expense"
        # Expense: destination expense account first, then category.
        dest_type = (journal.get("destination_type") or "").lower()
        dest_name = journal.get("destination_name")
        if dest_name and ("expense" in dest_type or dest_type == ""):
            category, source = dest_name, "expense_account"
        elif journal.get("category_name"):
            category, source = journal["category_name"], "category"
        else:
            category, source = UNCLASSIFIED, "unclassified"
    elif journal_type == "deposit":
        kind = "income"
        # Income: source revenue account first, then category.
        # (Refund deposits keep their expense-account source as key so the
        # management view can offset the original expense category.)
        src_type = (journal.get("source_type") or "").lower()
        src_name = journal.get("source_name")
        if src_name and ("revenue" in src_type or "expense" in src_type or src_type == ""):
            category = src_name
            source = "expense_account" if "expense" in src_type else "revenue_account"
        elif journal.get("category_name"):
            category, source = journal["category_name"], "category"
        else:
            category, source = UNCLASSIFIED, "unclassified"
    else:
        return {"kind": "skip", "special": special}

    try:
        amount = Decimal(journal.get("amount", "0"))
    except Exception:
        return {"kind": "skip", "special": special}

    return {
        "kind": kind,
        "special": special,
        "category": category,
        "classification_source": source,
        "currency": (journal.get("currency_code") or BASE).upper(),
        "amount": amount,
        "date": str(journal.get("date") or "")[:10],
        "journal_id": journal.get("transaction_journal_id") or journal.get("id") or "0",
        "description": journal.get("description") or "",
    }


class FXLookup:
    """Transaction-date FX with per-(currency, date) memoization."""

    def __init__(self, repository: FXRateRepository):
        self._repository = repository
        self._cache: dict[tuple[str, str], Decimal | None] = {}
        self.missing: set[tuple[str, str]] = set()

    def rate(self, currency: str, on_date: str) -> Decimal | None:
        if currency == BASE:
            return Decimal(1)
        key = (currency, on_date)
        if key not in self._cache:
            row = self._repository.effective_rate(currency, on_date)
            self._cache[key] = Decimal(str(row["rate"])) if row else None
        if self._cache[key] is None:
            self.missing.add(key)
        return self._cache[key]


def compute_income_statement(
    transaction_groups: list[dict],
    start_date: str,
    end_date: str,
    accounting_view: str,
    fx_repository: FXRateRepository,
) -> ReportEnvelope:
    """Compute the period income statement from Firefly transaction groups."""
    fx = FXLookup(fx_repository)
    warnings: list[str] = []

    # category → accumulators (original currency kept per (category, currency))
    income_native: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    expense_native: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    income_mgmt: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    expense_mgmt: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    # Per-category CNY value, summed journal-by-journal at transaction-date
    # rates (a category total cannot be converted with a single rate).
    income_cat_base: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    expense_cat_base: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    income_cat_base_native: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    expense_cat_base_native: dict[tuple[str, str], Decimal] = defaultdict(Decimal)
    counts: dict[tuple[str, str, str], int] = defaultdict(int)  # (side, category, currency)
    class_sources: dict[str, str] = {}

    # CNY-converted totals (only trustworthy when no FX missing)
    income_base = Decimal(0)
    expense_base = Decimal(0)
    income_base_native = Decimal(0)
    expense_base_native = Decimal(0)

    income_by_currency: dict[str, Decimal] = defaultdict(Decimal)
    expense_by_currency: dict[str, Decimal] = defaultdict(Decimal)

    special_rows: dict[str, list[ReportSectionRow]] = {
        "migration": [], "adjustment": [], "refund": [], "income_reversal": [],
    }
    unclassified_count = 0
    unclassified_by_currency: dict[str, Decimal] = defaultdict(Decimal)
    transfer_count = 0
    account_transfer_count = 0

    for journal in iter_journals(transaction_groups):
        c = classify_journal(journal)
        if c["kind"] == "transfer":
            transfer_count += 1
            continue
        if c["kind"] == "account_transfer":
            # asset/liability ↔ asset/liability: excluded from both views.
            account_transfer_count += 1
            continue
        if c["kind"] == "skip":
            continue

        category, currency, amount = c["category"], c["currency"], c["amount"]
        rate = fx.rate(currency, c["date"]) if amount != 0 else Decimal(0)
        converted = amount * rate if rate is not None else None
        class_sources.setdefault(category, c["classification_source"])

        if c["classification_source"] == "unclassified":
            unclassified_count += 1
            unclassified_by_currency[currency] += amount

        row = ReportSectionRow(
            label=category, currency=currency,
            amount=decimal_text(amount),
            amount_base=decimal_text(converted) if converted is not None else None,
            count=1,
            extra={"journal_id": str(c["journal_id"]), "date": c["date"]},
        )

        # ---------------- native view: raw Firefly semantics ----------------
        if c["kind"] == "income":
            income_native[(category, currency)] += amount
            if converted is not None:
                income_base_native += converted
                income_cat_base_native[(category, currency)] += converted
        else:
            expense_native[(category, currency)] += amount
            if converted is not None:
                expense_base_native += converted
                expense_cat_base_native[(category, currency)] += converted

        # ---------------- management view ----------------
        special = c["special"]
        if special == "migration":
            special_rows["migration"].append(row)
            continue
        if special == "adjustment":
            special_rows["adjustment"].append(row)
            continue
        if special == "refund" and c["kind"] == "income":
            # Refund offsets the original expense category; never income.
            special_rows["refund"].append(row)
            expense_mgmt[(category, currency)] -= amount
            expense_by_currency[currency] -= amount
            if converted is not None:
                expense_base -= converted
                expense_cat_base[(category, currency)] -= converted
            continue
        if special == "income_reversal" and c["kind"] == "expense":
            special_rows["income_reversal"].append(row)
            income_mgmt[(category, currency)] -= amount
            income_by_currency[currency] -= amount
            if converted is not None:
                income_base -= converted
                income_cat_base[(category, currency)] -= converted
            continue

        if c["kind"] == "income":
            income_mgmt[(category, currency)] += amount
            income_by_currency[currency] += amount
            counts[("income", category, currency)] += 1
            if converted is not None:
                income_base += converted
                income_cat_base[(category, currency)] += converted
        else:
            expense_mgmt[(category, currency)] += amount
            expense_by_currency[currency] += amount
            counts[("expense", category, currency)] += 1
            if converted is not None:
                expense_base += converted
                expense_cat_base[(category, currency)] += converted

    # -----------------------------------------------------------------
    # FX completeness — fail closed
    # -----------------------------------------------------------------
    missing_currencies = sorted({c for c, _ in fx.missing})
    fx_complete = not missing_currencies
    if missing_currencies:
        dates = sorted(d for _, d in fx.missing)
        warnings.append(
            f"缺少交易日汇率：{', '.join(missing_currencies)}"
            f"（{dates[0]} 至 {dates[-1]}）；CNY 合计不可用"
        )

    view = accounting_view if accounting_view in ("native", "management") else "management"
    income_cats = income_native if view == "native" else income_mgmt
    expense_cats = expense_native if view == "native" else expense_mgmt

    def _section_rows(cats: dict[tuple[str, str], Decimal], side: str) -> list[ReportSectionRow]:
        if view == "native":
            base_map = income_cat_base_native if side == "income" else expense_cat_base_native
        else:
            base_map = income_cat_base if side == "income" else expense_cat_base
        rows = []
        for (category, currency), amount in sorted(cats.items(), key=lambda kv: -abs(kv[1])):
            if amount == 0:
                continue
            converted = base_map.get((category, currency)) if fx_complete else None
            rows.append(ReportSectionRow(
                label=category, currency=currency,
                amount=decimal_text(amount),
                amount_base=decimal_text(converted) if converted is not None else None,
                count=counts.get((side, category, currency), 0),
                extra={"classification_source": class_sources.get(category, "unclassified")},
            ))
        return rows

    sections = [
        ReportSection(key="income", title="收入", rows=_section_rows(income_cats, "income")),
        ReportSection(key="expenses", title="费用", rows=_section_rows(expense_cats, "expense")),
        ReportSection(key="adjustments", title="调整项目",
                      rows=special_rows["adjustment"] + special_rows["income_reversal"]),
        ReportSection(key="migration", title="迁移项目（不计入管理口径）",
                      rows=special_rows["migration"]),
        ReportSection(key="refunds", title="退款（冲减费用）", rows=special_rows["refund"]),
    ]

    total_income = total_expenses = net_result = savings_rate = None
    if fx_complete:
        inc = income_base if view == "management" else income_base_native
        exp = expense_base if view == "management" else expense_base_native
        total_income, total_expenses = inc, exp
        net_result = inc - exp
        if inc > 0:
            savings_rate = (net_result / inc * 100).quantize(Decimal("0.1"))

    summary = {
        "accounting_view": view,
        "total_income_cny": decimal_text(total_income) if total_income is not None else None,
        "total_expenses_cny": decimal_text(total_expenses) if total_expenses is not None else None,
        "net_result_cny": decimal_text(net_result) if net_result is not None else None,
        "savings_rate_pct": str(savings_rate) if savings_rate is not None else None,
        "by_currency_income": {c: decimal_text(v) for c, v in sorted(income_by_currency.items()) if v != 0},
        "by_currency_expenses": {c: decimal_text(v) for c, v in sorted(expense_by_currency.items()) if v != 0},
        "native_control": {
            "income_cny": decimal_text(income_base_native) if fx_complete else None,
            "expenses_cny": decimal_text(expense_base_native) if fx_complete else None,
        },
        "classification_source": class_sources,
        "unclassified_count": unclassified_count,
        "unclassified_amounts_by_currency": {
            c: decimal_text(v) for c, v in sorted(unclassified_by_currency.items())
        },
        "transfer_excluded_count": transfer_count,
        "account_transfer_excluded_count": account_transfer_count,
        "missing_currencies": missing_currencies,
        "special_counts": {k: len(v) for k, v in special_rows.items()},
    }
    if unclassified_count:
        warnings.append(f"{unclassified_count} 笔交易无法分类，归入「未分类」")

    return ReportEnvelope(
        report_id=new_report_id("income_statement"),
        report_type="income_statement",
        base_currency=BASE,
        period={"start_date": start_date, "end_date": end_date},
        accounting_view=view,  # type: ignore[arg-type]
        fx_method="transaction_date",
        fx_complete=fx_complete,
        data_complete=fx_complete,
        warnings=warnings,
        summary=summary,
        sections=sections,
        presentation=build_income_statement_presentation(
            start_date=start_date, end_date=end_date, view=view,
            summary=summary, sections=sections,
            fx_complete=fx_complete, warnings=warnings,
        ),
    )
