"""交易明细（report-web 专用，只读）：journal 展开、筛选、交易日期汇率折算。

口径：与 PNL 一致按 journal 逐条处理；金额取绝对值展示，方向由 type 表达；
非基础币种优先使用交易日期历史汇率，缺失时回退最近可用汇率（fx_exact=False）。
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from finance_bridge.app.reporting.income_statement import classify_journal
from finance_bridge.app.storage.fx_rates import FXRateRepository


def _rate_for(
    repo: FXRateRepository,
    currency: str,
    date_str: str,
    base: str,
) -> tuple[Decimal | None, bool]:
    """返回 (汇率, 是否精确)。CNY 恒为 (1, True)。

    P1 修复（口径）：历史交易只能使用交易日或交易日前已知的汇率。
    - `historical_rate` 返回"<= 交易日的最近一条"（周末/节假日前向填充）；
      仅当 rate_date == 交易日期才算 fx_exact=True。
    - 交易日前不存在任何汇率时返回 None（**不得**用 `latest_rate` 的未来汇率，
      避免前视偏差）。
    """
    if currency == base:
        return Decimal(1), True
    info = repo.historical_rate(currency, date_str)
    if info:
        rate = Decimal(str(info["rate"]))
        exact = info.get("rate_date") == date_str
        return rate, exact
    return None, False


def _management_bucket(classified: dict[str, Any]) -> str | None:
    """management 报表口径 bucket；分派表必须与 compute_income_statement 一致。

    - transfer / account_transfer / skip：两侧均排除；
    - special=migration / adjustment：两侧均排除；
    - kind=income + special=refund → expense（退款冲减原支出 category）；
    - kind=expense + special=income_reversal → income（收入冲回冲减原收入 category）；
    - 其余按 kind 落 income/expense（含 kind=expense+refund 等异常标签组合）。
    """
    kind, special = classified["kind"], classified["special"]
    if kind in ("transfer", "account_transfer", "skip"):
        return None
    if special in ("migration", "adjustment"):
        return None
    if special == "refund" and kind == "income":
        return "expense"
    if special == "income_reversal" and kind == "expense":
        return "income"
    return kind


def build_ledger_rows(
    transaction_groups: list[dict[str, Any]],
    base_currency: str,
    repo: FXRateRepository,
    account: str | None = None,
    category: str | None = None,
    txn_type: str | None = None,
    *,
    report_side: str | None = None,
    report_category: str | None = None,
) -> dict[str, Any]:
    """把 Firefly 交易组展开为明细行并过滤。

    ``report_side`` + ``report_category`` 为 management 报表口径筛选：仅当
    二者均为非空值时启用，逐 journal 复用 ``classify_journal()`` 分类（禁止
    第二套分类优先级），与既有 ``category``/``account``/``txn_type`` 交集。
    """
    use_report_filter = bool(report_side) and bool(report_category)
    rows: list[dict[str, Any]] = []
    rate_cache: dict[tuple[str, str], tuple[Decimal | None, bool]] = {}
    for group in transaction_groups:
        journals = (group.get("attributes") or {}).get("transactions") or []
        for journal in journals:
            if not isinstance(journal, dict):
                continue
            jtype = str(journal.get("type") or "")
            if txn_type and jtype != txn_type:
                continue
            source = str(journal.get("source_name") or "")
            destination = str(journal.get("destination_name") or "")
            if account and account not in (source, destination):
                continue
            category_name = str(journal.get("category_name") or "")
            if category and category != category_name:
                continue
            if use_report_filter:
                classified = classify_journal(journal)
                if (_management_bucket(classified) != report_side
                        or classified.get("category") != report_category):
                    continue
            try:
                amount = abs(Decimal(str(journal.get("amount") or "0")))
            except Exception:
                continue
            if amount == 0:
                continue
            currency = (journal.get("currency_code") or base_currency).upper()
            date_str = str(journal.get("date") or "")[:10]
            rate_key = (currency, date_str)
            if rate_key not in rate_cache:
                rate_cache[rate_key] = _rate_for(repo, currency, date_str, base_currency)
            rate, exact = rate_cache[rate_key]
            amount_base = (
                None
                if rate is None
                else str((amount * rate).quantize(Decimal("0.01")))
            )
            rows.append({
                "date": date_str,
                "type": jtype,
                "description": str(journal.get("description") or ""),
                "category": category_name,
                "source": source,
                "destination": destination,
                "amount_native": str(amount.quantize(Decimal("0.01"))),
                "currency": currency,
                "amount_base": amount_base,
                "fx_exact": exact,
                "tags": [str(t) for t in (journal.get("tags") or [])],
                "journal_id": str(journal.get("transaction_journal_id") or journal.get("id") or ""),
            })
    rows.sort(key=lambda r: (r["date"], r["journal_id"]), reverse=True)
    return {"total": len(rows), "rows": rows}
