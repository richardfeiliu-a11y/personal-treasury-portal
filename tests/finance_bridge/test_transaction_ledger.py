"""交易明细模块单测：journal 展开、过滤、汇率折算与排序。"""
from __future__ import annotations

from decimal import Decimal

import pytest

from finance_bridge.app.domain.transaction_ledger import build_ledger_rows
from finance_bridge.app.storage.fx_rates import FXRateRepository


def _group(journals: list[dict]) -> dict:
    return {"id": "g1", "attributes": {"transactions": journals}}


def _journal(**kw) -> dict:
    base = {
        "type": "withdrawal",
        "date": "2026-08-01",
        "description": "咖啡",
        "category_name": "餐饮",
        "source_name": "银行甲存款",
        "destination_name": "咖啡店",
        "amount": "-35.00",
        "currency_code": "CNY",
        "tags": [],
        "transaction_journal_id": "j1",
    }
    base.update(kw)
    return base


@pytest.fixture(autouse=True)
def _fresh_storage():
    """每条测试使用独立临时数据库，汇率数据不跨测试泄漏。

    注意：不能用 `run_migrations()`（其签名需要 conn/migrations_dir，直接调用会 TypeError）；
    用 `reset_state()` 重建存储。
    """
    from finance_bridge.app.state import reset_state
    reset_state()
    yield


def _seed_eur_rate(repo: FXRateRepository) -> None:
    # upsert_market 已确认签名：upsert_market(currency, rate_to_cny, rate_date, source="ECB")
    repo.upsert_market("EUR", "7.5", "2026-08-01")


def test_expands_journals_and_sorts_desc():
    groups = [
        _group([_journal(description="咖啡", date="2026-08-01", transaction_journal_id="j1")]),
        _group([_journal(description="房租", date="2026-08-05", transaction_journal_id="j2")]),
    ]
    result = build_ledger_rows(groups, "CNY", FXRateRepository())
    assert result["total"] == 2
    assert result["rows"][0]["journal_id"] == "j2"  # 日期降序
    row = result["rows"][1]
    assert row["amount_native"] == "35.00"  # 取绝对值
    assert row["amount_base"] == "35.00"
    assert row["fx_exact"] is True


def test_filters_account_category_and_type():
    groups = [
        _group([_journal(description="咖啡", source_name="银行甲存款", type="withdrawal", category_name="餐饮")]),
        _group([_journal(description="工资", source_name="公司", destination_name="银行甲存款", type="deposit", category_name="工资")]),
        _group([_journal(description="转账", source_name="银行甲存款", destination_name="Wallet A", type="transfer", category_name="转账")]),
    ]
    assert build_ledger_rows(groups, "CNY", FXRateRepository(), account="银行甲存款")["total"] == 3
    assert build_ledger_rows(groups, "CNY", FXRateRepository(), category="餐饮")["total"] == 1
    assert build_ledger_rows(groups, "CNY", FXRateRepository(), txn_type="deposit")["total"] == 1


def test_fx_exact_true_when_rate_date_matches_transaction():
    """P1 修复：交易日存在汇率 → fx_exact=True。"""
    repo = FXRateRepository()
    _seed_eur_rate(repo)  # rate_date=2026-08-01
    groups = [_group([_journal(type="withdrawal", amount="-10.00", currency_code="EUR",
                               date="2026-08-01", transaction_journal_id="j1")])]
    result = build_ledger_rows(groups, "CNY", repo)
    row = result["rows"][0]
    assert row["fx_exact"] is True
    assert row["amount_base"] == "75.00"


def test_fx_exact_false_on_weekend_forward_fill():
    """P1 修复：周末/节假日使用此前工作日汇率（rate_date < 交易日）→ fx_exact=False。"""
    repo = FXRateRepository()
    _seed_eur_rate(repo)  # 只有 2026-08-01（周六）的汇率
    groups = [_group([_journal(type="withdrawal", amount="-10.00", currency_code="EUR",
                               date="2026-08-03", transaction_journal_id="j1")])]  # 周一
    result = build_ledger_rows(groups, "CNY", repo)
    row = result["rows"][0]
    assert row["fx_exact"] is False
    assert row["amount_base"] == "75.00"  # 前向填充汇率仍用于折算


def test_no_rate_before_transaction_means_null_not_future_rate():
    """P1 修复：交易日前无任何汇率 → amount_base=None，不得使用未来汇率（前视偏差）。"""
    repo = FXRateRepository()
    _seed_eur_rate(repo)  # 只有 2026-08-01 的汇率
    groups = [_group([_journal(type="withdrawal", amount="-10.00", currency_code="EUR",
                               date="2026-07-01", transaction_journal_id="j1")])]  # 早于汇率日期
    result = build_ledger_rows(groups, "CNY", repo)
    row = result["rows"][0]
    assert row["amount_base"] is None
    assert row["fx_exact"] is False


def test_skips_unparseable_amounts():
    groups = [_group([_journal(amount="abc")]), _group([_journal(amount="0")])]
    assert build_ledger_rows(groups, "CNY", FXRateRepository())["total"] == 0


# ---------------------------------------------------------------------------
# WP1：management 报表口径筛选（report_side + report_category）
# 口径必须与 income_statement.classify_journal() 的 management view 完全一致。
# ---------------------------------------------------------------------------

from finance_bridge.app.reporting.income_statement import UNCLASSIFIED  # noqa: E402


def _mgmt_journal(**kw) -> dict:
    """带 account type 的 journal，使 classify_journal 能按账户类型分类。"""
    base = {
        "type": "withdrawal",
        "date": "2026-08-01",
        "description": "咖啡",
        "category_name": "餐饮",
        "source_name": "银行甲存款",
        "source_type": "Asset account",
        "destination_name": "咖啡店",
        "destination_type": "Expense account",
        "amount": "-35.00",
        "currency_code": "CNY",
        "tags": [],
        "transaction_journal_id": "j1",
    }
    base.update(kw)
    return base


def test_report_filter_ordinary_expense_matches_expense_account_name():
    """报表 label 来自 expense account name，而非 raw category_name。"""
    groups = [
        _group([_mgmt_journal(destination_name="咖啡店", category_name="餐饮",
                              transaction_journal_id="j1")]),
        _group([_mgmt_journal(destination_name="超市", category_name="餐饮",
                              transaction_journal_id="j2")]),
    ]
    result = build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="expense", report_category="咖啡店",
    )
    assert result["total"] == 1
    assert result["rows"][0]["journal_id"] == "j1"
    # 输出的 category 仍是原始 Firefly category_name
    assert result["rows"][0]["category"] == "餐饮"
    # raw category 不作为报表匹配键
    assert build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="expense", report_category="餐饮",
    )["total"] == 0


def test_report_filter_ordinary_income_matches_revenue_account_name():
    groups = [
        _group([_mgmt_journal(
            type="deposit", source_name="雇主公司", source_type="Revenue account",
            destination_name="银行甲存款", destination_type="Asset account",
            category_name="工资", amount="10000.00", transaction_journal_id="j1",
        )]),
    ]
    result = build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="income", report_category="雇主公司",
    )
    assert result["total"] == 1
    assert build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="income", report_category="工资",
    )["total"] == 0


def test_report_filter_refund_deposit_buckets_to_expense():
    """refund deposit 在 management 口径冲减 expense（原 expense category）。"""
    groups = [
        _group([_mgmt_journal(
            type="deposit", tags=["refund"],
            source_name="咖啡店", source_type="Expense account",
            destination_name="银行甲存款", destination_type="Asset account",
            category_name="退款", amount="35.00", transaction_journal_id="j1",
        )]),
    ]
    assert build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="expense", report_category="咖啡店",
    )["total"] == 1
    assert build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="income", report_category="咖啡店",
    )["total"] == 0


def test_report_filter_income_reversal_withdrawal_buckets_to_income():
    """income-reversal withdrawal 在 management 口径冲减 income。"""
    groups = [
        _group([_mgmt_journal(
            type="withdrawal", tags=["income-reversal"],
            source_name="银行甲存款", source_type="Asset account",
            destination_name="雇主公司", destination_type="Revenue account",
            category_name="工资", amount="-500.00", transaction_journal_id="j1",
        )]),
    ]
    assert build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="income", report_category="工资",
    )["total"] == 1
    assert build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="expense", report_category="工资",
    )["total"] == 0


def test_report_filter_excludes_migration_adjustment_transfers():
    """migration/adjustment/transfer/account_transfer 在两侧均不命中。"""
    groups = [
        _group([_mgmt_journal(tags=["migration"], transaction_journal_id="j1")]),
        _group([_mgmt_journal(tags=["manual-reconciliation"], transaction_journal_id="j2")]),
        _group([_mgmt_journal(type="transfer", destination_name="Wallet A",
                              destination_type="Asset account",
                              category_name="转账", transaction_journal_id="j3")]),
        # asset→asset withdrawal = account_transfer（如信用卡还款）
        _group([_mgmt_journal(destination_name="Card A", destination_type="Credit card",
                              category_name="餐饮", transaction_journal_id="j4")]),
    ]
    for side in ("expense", "income"):
        assert build_ledger_rows(
            groups, "CNY", FXRateRepository(),
            report_side=side, report_category="餐饮",
        )["total"] == 0
        assert build_ledger_rows(
            groups, "CNY", FXRateRepository(),
            report_side=side, report_category="咖啡店",
        )["total"] == 0


def test_report_filter_unclassified_per_side():
    """report_category=未分类 匹配 classify_journal 的 UNCLASSIFIED，按 side 分开。"""
    groups = [
        _group([_mgmt_journal(
            destination_name="", destination_type="", category_name="",
            transaction_journal_id="j1",
        )]),
        _group([_mgmt_journal(
            type="deposit", source_name="", source_type="", category_name="",
            destination_name="银行甲存款", destination_type="Asset account",
            amount="10.00", transaction_journal_id="j2",
        )]),
    ]
    assert build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="expense", report_category=UNCLASSIFIED,
    )["rows"][0]["journal_id"] == "j1"
    assert build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="income", report_category=UNCLASSIFIED,
    )["rows"][0]["journal_id"] == "j2"


def test_report_filter_same_label_income_vs_expense_separated():
    """同名 label 的收入与支出分别只命中各自 side。"""
    groups = [
        _group([_mgmt_journal(destination_name="副业", transaction_journal_id="j1")]),
        _group([_mgmt_journal(
            type="deposit", source_name="副业", source_type="Revenue account",
            destination_name="银行甲存款", destination_type="Asset account",
            amount="200.00", transaction_journal_id="j2",
        )]),
    ]
    assert [r["journal_id"] for r in build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="expense", report_category="副业",
    )["rows"]] == ["j1"]
    assert [r["journal_id"] for r in build_ledger_rows(
        groups, "CNY", FXRateRepository(),
        report_side="income", report_category="副业",
    )["rows"]] == ["j2"]


def test_report_filter_intersects_raw_category_account_and_type():
    """report pair 与既有 category/account/txn_type 筛选是交集关系。"""
    groups = [
        _group([_mgmt_journal(category_name="餐饮", transaction_journal_id="j1")]),
        _group([_mgmt_journal(category_name="购物", source_name="Wallet A",
                              transaction_journal_id="j2")]),
    ]
    common = {"report_side": "expense", "report_category": "咖啡店"}
    assert build_ledger_rows(groups, "CNY", FXRateRepository(),
                             category="餐饮", **common)["rows"][0]["journal_id"] == "j1"
    assert build_ledger_rows(groups, "CNY", FXRateRepository(),
                             account="Wallet A", **common)["rows"][0]["journal_id"] == "j2"
    assert build_ledger_rows(groups, "CNY", FXRateRepository(),
                             txn_type="deposit", **common)["total"] == 0


def test_report_filter_partial_pair_ignored():
    """只传一个 report 参数时忽略 report filter（冻结契约）。"""
    groups = [
        _group([_mgmt_journal(transaction_journal_id="j1")]),
        _group([_mgmt_journal(destination_name="超市", transaction_journal_id="j2")]),
    ]
    assert build_ledger_rows(groups, "CNY", FXRateRepository(),
                             report_side="expense")["total"] == 2
    assert build_ledger_rows(groups, "CNY", FXRateRepository(),
                             report_category="咖啡店")["total"] == 2
    assert build_ledger_rows(groups, "CNY", FXRateRepository(),
                             report_side="", report_category="咖啡店")["total"] == 2
