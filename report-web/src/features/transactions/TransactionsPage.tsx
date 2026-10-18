import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Download, RefreshCw, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useAccountBalances, useTransactions } from "../../api/hooks";
import { Amount } from "../../components/Amount";
import { useAppHeader } from "../../components/AppHeader";
import { EmptyState } from "../../components/EmptyState";
import { QuickCommandCopy } from "../../components/QuickCommandCopy";
import { ReportTimestampFooter } from "../../components/ReportTimestampFooter";
import { PeriodToolbar } from "../../components/PeriodToolbar";
import { ErrorBanner, WarningBanner } from "../../components/StatusBanner";
import { StaleDataBanner } from "../../components/StaleDataBanner";
import { useToast } from "../../components/Toast";
import { berlinLastNDays } from "../../utils/dates";
import {
  buildCsv,
  buildExportFilename,
  triggerCsvDownload,
} from "../../utils/csvExport";
import { usePageTitle } from "../../utils/pageTitle";
import {
  BASE_SEGMENTEDITEM, SEGMENTEDITEM_ISACTIVE,
  BASE_TAG, BADGE_TAGNEGATIVE,
  BASE_BTNCHIP, CTX_BTNCHIP,
} from "../../utils/legacyClasses";

type TypeKey = "all" | "withdrawal" | "deposit" | "transfer";

const TYPE_KEYS: readonly TypeKey[] = [
  "all",
  "withdrawal",
  "deposit",
  "transfer",
];

function isTypeKey(value: string | null): value is TypeKey {
  return (
    value !== null && (TYPE_KEYS as readonly string[]).includes(value)
  );
}

/** 从 URL 读取非负整数参数；缺省或非法时回退 0。 */
function parseOffset(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const typeLabels: Record<TypeKey, string> = {
  all: "全部",
  withdrawal: "支出",
  deposit: "收入",
  transfer: "转账",
};

/**
 * 明细页（shadcn/Tailwind 第二批迁移）。
 * URL 作为筛选唯一事实来源的全部逻辑、ResponsiveDataView 双轨、分页与报表口径
 * chip 均保持不变；呈现层精修：结果卡、sticky 紧凑表头、金额右对齐、行 hover。
 */
export function TransactionsPage() {
  usePageTitle("明细");
  const qc = useQueryClient();
  const { showToast } = useToast();
  // WP05/RV-05（DATA-01）：默认区间取 Europe/Berlin 最近30天。
  const period = useMemo(() => berlinLastNDays(30), []);
  const [searchParams, setSearchParams] = useSearchParams();
  const paramsKey = searchParams.toString();

  const [startDate, setStartDate] = useState(
    () => searchParams.get("start") ?? period.start,
  );
  const [endDate, setEndDate] = useState(
    () => searchParams.get("end") ?? period.end,
  );
  // 最后有效的查询区间：日期非法时保留旧值。
  const [queryPeriod, setQueryPeriod] = useState(() => ({
    start: searchParams.get("start") ?? period.start,
    end: searchParams.get("end") ?? period.end,
  }));
  const [category, setCategory] = useState(
    () => searchParams.get("category") ?? "",
  );
  const [keyword, setKeyword] = useState(
    () => searchParams.get("keyword") ?? "",
  );
  const [account, setAccount] = useState(
    () => searchParams.get("account") ?? "",
  );
  const [txnType, setTxnType] = useState<TypeKey>(() =>
    isTypeKey(searchParams.get("txnType"))
      ? (searchParams.get("txnType") as TypeKey)
      : "all",
  );
  const offset = parseOffset(searchParams.get("offset"));
  const PAGE_SIZE = 100;

  // management 报表口径深链（spec §5.3）：report_side + report_category 成对有效。
  const reportSideParam = searchParams.get("report_side");
  const reportCategoryParam = searchParams.get("report_category");
  const reportSide =
    reportSideParam === "expense" || reportSideParam === "income"
      ? reportSideParam
      : null;
  const reportFilter: { side: "expense" | "income"; category: string } | null =
    reportSide && reportCategoryParam
      ? { side: reportSide, category: reportCategoryParam }
      : null;

  /** 清除报表口径 chip：原子删两个 report 参数并重置 offset（AC-D06）。 */
  const handleClearReportFilter = () => {
    const params = new URLSearchParams(searchParams);
    params.delete("report_side");
    params.delete("report_category");
    params.delete("offset");
    setSearchParams(params, { replace: true });
  };

  // URL → 本地瞬时状态。
  useEffect(() => {
    const urlStart = searchParams.get("start");
    const urlEnd = searchParams.get("end");
    if (urlStart || urlEnd) {
      const nextStart = urlStart ?? period.start;
      const nextEnd = urlEnd ?? period.end;
      setStartDate(nextStart);
      setEndDate(nextEnd);
      if (!nextStart || !nextEnd || nextStart <= nextEnd) {
        setQueryPeriod({ start: nextStart, end: nextEnd });
      }
    }
    if (isTypeKey(searchParams.get("txnType"))) {
      setTxnType(searchParams.get("txnType") as TypeKey);
    } else {
      setTxnType("all");
    }
    setCategory(searchParams.get("category") ?? "");
    setKeyword(searchParams.get("keyword") ?? "");
    setAccount(searchParams.get("account") ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  const accounts = useAccountBalances();
  const q = useTransactions({
    start: queryPeriod.start,
    end: queryPeriod.end,
    account: account || undefined,
    category: category || undefined,
    txnType: txnType === "all" ? undefined : txnType,
    reportSide: reportFilter?.side,
    reportCategory: reportFilter?.category,
    limit: PAGE_SIZE,
    offset,
  });
  const refresh = () => void qc.invalidateQueries();
  const periodError =
    startDate && endDate && startDate > endDate
      ? "起始日期不能晚于截止日期"
      : undefined;

  /** 以当前 URL 为基底应用覆盖项；默认值参数省略（干净 URL）。 */
  const replaceUrl = (overrides: {
    start?: string;
    end?: string;
    account?: string;
    category?: string;
    keyword?: string;
    txnType?: TypeKey;
    offset?: number;
  }) => {
    const params = new URLSearchParams(searchParams);
    const apply = (
      key: string,
      value: string | undefined,
      isDefault: boolean,
    ) => {
      if (value === undefined) return;
      if (isDefault || value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    };
    apply("start", overrides.start, overrides.start === period.start);
    apply("end", overrides.end, overrides.end === period.end);
    apply("account", overrides.account, overrides.account === "");
    apply("category", overrides.category, overrides.category === "");
    apply("keyword", overrides.keyword, overrides.keyword === "");
    apply("txnType", overrides.txnType, overrides.txnType === "all");
    apply(
      "offset",
      overrides.offset === undefined
        ? undefined
        : String(overrides.offset),
      overrides.offset === 0,
    );
    setSearchParams(params, { replace: true });
  };

  const handleStartDateChange = (value: string) => {
    // 输入始终回显；仅在区间有效时推进查询期间（无效则保留旧期间、显示错误）。
    setStartDate(value);
    if (!value || !endDate || value <= endDate) {
      setQueryPeriod({ start: value, end: endDate });
      replaceUrl({ start: value, offset: 0 });
    }
  };

  const handleEndDateChange = (value: string) => {
    setEndDate(value);
    if (!startDate || !value || startDate <= value) {
      setQueryPeriod({ start: startDate, end: value });
      replaceUrl({ end: value, offset: 0 });
    }
  };

  const handleCategoryChange = (value: string) => {
    setCategory(value);
    replaceUrl({ category: value, offset: 0 });
  };

  const handleKeywordChange = (value: string) => {
    setKeyword(value);
    replaceUrl({ keyword: value, offset: 0 });
  };

  const handleTxnTypeChange = (key: TypeKey) => {
    setTxnType(key);
    replaceUrl({ txnType: key, offset: 0 });
  };

  const handleAccountChange = (value: string) => {
    setAccount(value);
    replaceUrl({ account: value, offset: 0 });
  };

  const handlePrevPage = () => {
    replaceUrl({ offset: Math.max(0, offset - PAGE_SIZE) });
  };

  const handleNextPage = () => {
    replaceUrl({ offset: offset + PAGE_SIZE });
  };

  /** Web → Hermes Quick Command：journal_id 确定性核对指令。 */
  const quickCommandText = (row: {
    journal_id: string;
    date: string;
    description: string;
    amount_native: string;
    currency: string;
  }) =>
    `核对交易 journal_id=${row.journal_id} 日期=${row.date} 描述=${row.description} 金额=${row.amount_native} ${row.currency}`;

  const rows = q.data?.rows ?? [];
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  // Bridge 契约无 keyword 参数：在已加载只读页内本地匹配，不改服务端分页。
  const filteredRows = normalizedKeyword
    ? rows.filter((row) =>
        [
          row.description,
          row.source,
          row.destination,
          row.category,
          row.journal_id,
          ...row.tags,
        ].some((value) =>
          value.toLocaleLowerCase().includes(normalizedKeyword),
        ),
      )
    : rows;
  const serverTotal = q.data?.total ?? 0;

  /**
   * 导出当前页已加载的行（非全量）：沿用 WP08 诚实语义——服务端分页 total
   * 不被命中数改写，导出同理不冒充全量。搜索生效时导出筛选后的结果，
   * 按钮文案如实标注条数。纯客户端，不新增后端请求。
   */
  const handleExportCsv = () => {
    if (filteredRows.length === 0) {
      showToast("当前没有可导出的交易");
      return;
    }
    const period = q.data
      ? { start: q.data.period_from, end: q.data.period_to }
      : { start: queryPeriod.start, end: queryPeriod.end };
    triggerCsvDownload(
      buildCsv(filteredRows),
      buildExportFilename({ ...period, count: filteredRows.length }),
    );
    showToast(`已导出本页 ${filteredRows.length} 条`);
  };

  useAppHeader({
    title: "明细",
    meta: (
      <span>
        {q.data
          ? `${q.data.period_from} ~ ${q.data.period_to} · 共 ${q.data.total} 笔`
          : "选择期间"}
      </span>
    ),
    actions: (
      <>
        <button
          type="button"
          className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]"
        onClick={refresh}
        disabled={Boolean(periodError)}
      >
        <RefreshCw size={15} aria-hidden="true" />
        {/* 移动端顶栏宽度预算只够图标（与 ProductSwitcher 的 max-md:sr-only 同模式）：
            两个带文字的页级按钮会把标题轨压到零宽，h1 被判为 hidden。 */}
        <span className="max-md:sr-only">刷新</span>
      </button>
      <button
        type="button"
        className={`${BASE_BTNCHIP} ${CTX_BTNCHIP} max-md:h-[var(--touch-target)] max-md:min-h-[var(--touch-target)]`}
        onClick={handleExportCsv}
        disabled={filteredRows.length === 0}
        title={
          filteredRows.length === 0
            ? "当前没有可导出的交易"
            : `导出本页 ${filteredRows.length} 条为 CSV（不含其他页）`
        }
      >
        <Download size={15} aria-hidden="true" /> <span className="max-md:sr-only">导出本页{filteredRows.length > 0 ? ` (${filteredRows.length})` : ""}</span>
      </button>
      </>
    ),
  });

  const categoryOptions = useMemo(
    () =>
      Array.from(
        new Set(
          rows
            .map((r) => r.category)
            .filter((c): c is string => Boolean(c)),
        ),
      ),
    [rows],
  );

  return (
    <div className="page transactions-page flex flex-col gap-[var(--space-5)] animate-none max-sm:min-w-0 max-sm:max-w-full max-md:[&_button:not(header_&)]:min-h-[var(--touch-target)] max-md:[&_input]:min-h-[var(--touch-target)] max-md:[&_input]:h-[var(--touch-target)] max-md:[&_select]:min-h-[var(--touch-target)] max-md:[&_select]:h-[var(--touch-target)]">
      <StaleDataBanner queries={[q, accounts]} onRefresh={refresh} />
      <div className="period-toolbar period-filter-row inline-flex items-center gap-[var(--space-2)] flex-wrap flex flex-col gap-[var(--space-1)] items-start max-md:w-full max-sm:w-full max-sm:min-w-0 max-sm:max-w-full flex-row">
        <PeriodToolbar
          fromDate={startDate}
          toDate={endDate}
          onFromDateChange={handleStartDateChange}
          onToDateChange={handleEndDateChange}
          error={periodError}
        />
        <input
          className="h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:400_14px/1_var(--font-family-base)] w-full [transition:border-color_var(--duration-hover)_var(--ease-standard),_box-shadow_var(--duration-hover)_var(--ease-standard)] focus:outline-none focus:border-[var(--brand-accent)] focus:shadow-[0_0_0_3px_rgba(40,_160,_111,_0.10)] [&::placeholder]:text-[var(--text-placeholder)] [.period-toolbar-field_&]:w-[150px] [.period-toolbar-field_&]:border-[var(--danger-600)] max-md:[.period-toolbar-field_&]:w-full max-md:[.income-expense-page_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.income-expense-page_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.transactions-page_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.page:has(.fx-currency-list)_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.page:has(.fx-currency-list)_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)]"
          type="text"
          placeholder="本页搜索（仅在已加载的当前页内匹配）"
          aria-label="本页搜索"
          title="Bridge 契约暂无服务端关键词搜索；此处仅在当前已加载页内匹配，不改变服务端分页"
          value={keyword}
          onChange={(e) => handleKeywordChange(e.target.value)}
        />
        {keyword.trim() && (
          <button
            type="button"
            className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]"
            aria-label="清除本页搜索"
            onClick={() => {
              setKeyword("");
              replaceUrl({ keyword: "", offset: 0 });
            }}
          >
            <X size={13} aria-hidden="true" /> 清除本页搜索
          </button>
        )}
        {normalizedKeyword && (
          <span className="chip" role="status" aria-live="polite">
            本页命中 {filteredRows.length} 条
          </span>
        )}
        <input
          className="h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:400_14px/1_var(--font-family-base)] w-full [transition:border-color_var(--duration-hover)_var(--ease-standard),_box-shadow_var(--duration-hover)_var(--ease-standard)] focus:outline-none focus:border-[var(--brand-accent)] focus:shadow-[0_0_0_3px_rgba(40,_160,_111,_0.10)] [&::placeholder]:text-[var(--text-placeholder)] [.period-toolbar-field_&]:w-[150px] [.period-toolbar-field_&]:border-[var(--danger-600)] max-md:[.period-toolbar-field_&]:w-full max-md:[.income-expense-page_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.income-expense-page_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.transactions-page_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.page:has(.fx-currency-list)_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.page:has(.fx-currency-list)_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)]"
          type="text"
          placeholder="类别筛选"
          aria-label="类别筛选"
          list="category-options"
          value={category}
          onChange={(e) => handleCategoryChange(e.target.value)}
        />
        <datalist id="category-options">
          {categoryOptions.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <div className="inline-flex items-center gap-0 h-[var(--control-height)] p-[3px] bg-[var(--surface-subtle)] rounded-[10px] border-0 max-md:[.income-expense-page_&]:h-[var(--touch-target)] max-md:[.income-expense-page_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_&]:h-[var(--touch-target)] max-md:[.transactions-page_&]:min-h-[var(--touch-target)] max-md:[.income-expense-page_&]:py-0 max-md:[.transactions-page_&]:py-0" role="group" aria-label="交易类型">
          {(Object.keys(typeLabels) as TypeKey[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`${BASE_SEGMENTEDITEM}${txnType === key ? ` ${SEGMENTEDITEM_ISACTIVE}` : ""}`}
              aria-pressed={txnType === key}
              onClick={() => handleTxnTypeChange(key)}
            >
              {typeLabels[key]}
            </button>
          ))}
        </div>
        <select
          className="h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:400_14px/1_var(--font-family-base)] w-full [transition:border-color_var(--duration-hover)_var(--ease-standard),_box-shadow_var(--duration-hover)_var(--ease-standard)] focus:outline-none focus:border-[var(--brand-accent)] focus:shadow-[0_0_0_3px_rgba(40,_160,_111,_0.10)] max-md:[.transactions-page>.period-filter-row>&]:h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)]"
          aria-label="账户筛选"
          value={account}
          onChange={(e) => handleAccountChange(e.target.value)}
        >
          <option value="">全部账户</option>
          {(accounts.data?.accounts ?? []).map((a) => (
            <option key={a.id} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        {reportFilter ? (
          <span className="chip report-scope-chip inline-flex items-center gap-1.5 min-h-11 py-0 px-[var(--space-2)] border border-solid border-[var(--border-emphasis)] rounded-full bg-[var(--surface-raised)] text-[var(--text-body)] [font:var(--type-caption)] whitespace-nowrap" role="status">
            报表口径：{reportFilter.side === "expense" ? "支出" : "收入"} ·{" "}
            {reportFilter.category}
            <button
              type="button"
              className="chip-clear"
              aria-label="清除报表口径筛选"
              onClick={handleClearReportFilter}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ) : null}
      </div>

      {!q.error && <WarningBanner items={q.data?.fx_notes ?? []} />}

      {q.error ? (
        <ErrorBanner message={q.error.message} onRetry={refresh} />
      ) : q.isLoading ? (
        <div className="h-[300px] animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
      ) : filteredRows.length === 0 ? (
        rows.length === 0 ? (
          <EmptyState
            title="该期间暂无交易"
            description="调整日期区间或筛选条件。"
          />
        ) : (
          <EmptyState
            title="本页无命中"
            description="本页搜索仅在当前已加载页内匹配；可翻页前往其他页，或清除本页搜索。"
          />
        )
      ) : (
        <section
          className="card has-mobile-card transactions-results overflow-hidden !p-0 min-w-0 bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] p-[var(--card-padding)] [&[data-surface='glass']]:bg-[var(--glass-bg)] [&[data-surface='glass']]:[-webkit-backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:[backdrop-filter:var(--glass-blur)] [&[data-surface='glass']]:border-b [&[data-surface='glass']]:border-b-[var(--glass-border)] [&[data-surface='solid']]:bg-[var(--glass-solid-fallback)] [&[data-surface='solid']]:backdrop-filter-none [&[data-surface='solid']]:border-b [&[data-surface='solid']]:border-b-[var(--border-default)] [&[data-surface='solid']]:text-[var(--text-strong)] max-[479px]:p-[var(--card-padding-mobile)] max-[479px]:max-w-full max-sm:max-w-full [.home-page_&]:bg-[var(--card)] [.home-page_&]:backdrop-filter-none [[data-theme='dark']_&]:bg-[var(--card)] [[data-theme='dark']_&]:border-[var(--border-emphasis)] [.page_&]:bg-[var(--glass-solid-fallback)] [.page_&]:backdrop-filter-none"
          aria-label="交易明细"
        >
          {/* 桌面：sticky 紧凑表头 */}
          <div className="transactions-desktop-table data-table-wrap relative hidden md:block bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] overflow-x-auto md:min-w-0 lg:overflow-hidden max-[479px]:[-webkit-overflow-scrolling:touch]">
            <table
              className="data-table account-table md:min-w-[748px] lg:min-w-0"
              aria-label="交易明细"
            >
              <thead className="sticky top-0 z-10">
                <tr className="bg-[var(--surface-tint-neutral)]">
                  <th>日期</th>
                  <th>类型</th>
                  <th>描述</th>
                  <th>类别</th>
                  <th>来源 → 去向</th>
                  <th className="is-num text-right [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">金额（原币）</th>
                  <th className="is-num text-right [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">折 CNY</th>
                  <th className="is-actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => (
                  <tr
                    key={r.journal_id}
                    className="transition-colors hover:bg-[var(--surface-tint-neutral)]"
                  >
                    <td className="whitespace-nowrap">
                      {r.date}
                    </td>
                    <td>
                      {r.type === "withdrawal"
                        ? "支出"
                        : r.type === "deposit"
                          ? "收入"
                          : "转账"}
                    </td>
                    <td>{r.description || "—"}</td>
                    <td>
                      {r.category || "—"}
                    </td>
                    <td className="whitespace-nowrap">
                      {r.source} → {r.destination}
                    </td>
                    <td className="is-num text-right [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                      <Amount value={r.amount_native} currency={r.currency} />
                      {r.amount_base !== null && !r.fx_exact && (
                        <span title="使用交易日前最近汇率折算"> *</span>
                      )}
                      {r.amount_base === null && (
                        <span title="交易日前无可用汇率，未折算"> †</span>
                      )}
                    </td>
                    <td className="is-num text-right [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                      {r.amount_base === null ? (
                        "汇率缺失"
                      ) : (
                        <Amount value={r.amount_base} currency="CNY" />
                      )}
                    </td>
                    <td className="is-actions">
                      <QuickCommandCopy
                        text={quickCommandText(r)}
                        ariaLabel={`复制交易 ${r.description} 核对指令`}
                        title="复制飞书核对指令"
                        onSuccess={() => showToast("已复制飞书核对指令")}
                        onError={() => showToast("复制失败，请手动复制")}
                      >
                        <Copy size={14} aria-hidden="true" />
                      </QuickCommandCopy>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 移动卡片 */}
          <ul
            className="transactions-mobile-list hidden flex-col gap-3 w-full mt-3 mb-0 p-0 list-none max-md:flex max-md:[.accounts-page_&]:mt-0 max-md:mt-0"
            aria-label="交易明细卡片视图"
          >
            {filteredRows.map((r) => (
              <li
                key={r.journal_id}
                className="transaction-card bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl py-3.5 px-4 flex flex-col gap-2.5 shadow-[var(--shadow-sm)] max-sm:min-w-0 max-sm:max-w-full"
              >
                <div className="flex items-center justify-between gap-[var(--space-2)] mb-0.5 max-sm:min-w-0 max-sm:max-w-full w-full">
                  <span className="text-[14px] leading-[20px] font-medium text-[var(--text-body)] overflow-hidden [text-overflow:ellipsis] whitespace-nowrap max-sm:[overflow-wrap:anywhere] max-sm:break-normal min-w-0 [overflow-wrap:anywhere]">
                    {r.description || "—"} · {r.date}
                  </span>
                  <span
                    className={`${BASE_TAG}${r.type === "withdrawal" ? ` ${BADGE_TAGNEGATIVE}` : ""}`}
                  >
                    {r.type === "withdrawal"
                      ? "支出"
                      : r.type === "deposit"
                        ? "收入"
                        : "转账"}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-[var(--space-3)] max-sm:min-w-0 max-sm:max-w-full w-full">
                  <span className="text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal min-w-0 [overflow-wrap:anywhere] flex-1 text-left">
                    {r.source} → {r.destination} · {r.category || "未分类"}
                  </span>
                  <span className="transaction-card-value text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] max-w-[62%] shrink-0 [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                    <Amount value={r.amount_native} currency={r.currency} />
                    <span className="whitespace-normal text-[var(--text-faint)] text-[12px] font-normal">
                      {r.amount_base === null ? (
                        "汇率缺失"
                      ) : (
                        <>
                          <span aria-hidden="true"> · </span>
                          <Amount value={r.amount_base} currency="CNY" />
                        </>
                      )}
                    </span>
                  </span>
                </div>
                <div className="flex justify-end min-h-[30px]">
                  <QuickCommandCopy
                    text={quickCommandText(r)}
                    ariaLabel={`复制交易 ${r.description} 核对指令`}
                    title="复制飞书核对指令"
                    onSuccess={() => showToast("已复制飞书核对指令")}
                    onError={() => showToast("复制失败，请手动复制")}
                  >
                    <Copy size={14} aria-hidden="true" />
                  </QuickCommandCopy>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 分页控件：以服务端 total 为准，零命中仍可翻页。 */}
      {!q.error && !q.isLoading && q.data && (
        <div className="transactions-pagination inline-flex items-center gap-[var(--space-2)] flex-wrap justify-end mt-[var(--space-4)] max-md:justify-between max-md:items-start">
          <button
            type="button"
            className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]"
            disabled={offset === 0}
            onClick={handlePrevPage}
          >
            上一页
          </button>
          <span className="topbar-meta inline-flex items-center gap-[var(--space-3)] text-[var(--text-faint)] [font:var(--type-caption)] [.home-analysis-grid_&]:ml-[auto] [.home-analysis-grid_&]:text-right [.home-summary-grid_&]:ml-[auto] [.home-summary-grid_&]:text-right [.home-expense-ranking_&]:ml-[auto] [.home-expense-ranking_&]:text-right">
            第 {Math.floor(offset / PAGE_SIZE) + 1} /{" "}
            {Math.max(1, Math.ceil(serverTotal / PAGE_SIZE))} 页
            {normalizedKeyword
              ? ` · 本页搜索命中 ${filteredRows.length}`
              : ""}
          </span>
          <button
            type="button"
            className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]"
            disabled={serverTotal <= offset + PAGE_SIZE}
            onClick={handleNextPage}
          >
            下一页
          </button>
        </div>
      )}
      {/* transactions 契约只有期间端点（无 generated_at）。 */}
      <ReportTimestampFooter asOf={q.data?.period_to} />
    </div>
  );
}
