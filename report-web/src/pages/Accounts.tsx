import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Filter, RefreshCw, Search } from "lucide-react";
import { useAccountBalances } from "../api/hooks";
import { Amount } from "../components/Amount";
import { AccountCard } from "../components/AccountCard";
import { DeepLink } from "../components/DeepLink";
import { useAppHeader } from "../components/AppHeader";
import { Card } from "../components/Card";
import { ErrorBanner, WarningBanner } from "../components/StatusBanner";
import { EmptyState } from "../components/EmptyState";
import { ReportTimestampFooter } from "../components/ReportTimestampFooter";
import { StaleDataBanner } from "../components/StaleDataBanner";
import {
  applyFilters,
  DEFAULT_FILTERS,
  financialAccounts,
  groupOptions,
  isInvestmentAccount,
  sortAccounts,
  uniqueCurrencies,
  type AccountFilters,
  type SortDirection,
  type SortField,
} from "../utils/accounts";
import { formatDateCn } from "../utils/dates";
import { decSum, formatDecimal, parseDecimal } from "../utils/decimal";

/**
 * 账户页（shadcn/Tailwind 第二批迁移）。
 * 保留 query hooks、筛选/排序、渐进显示、AccountCard 与全部测试契约（.card-flat
 * 筛选面板 / account-table / account-card）；呈现层新增顶部汇总条与状态 Badge，
 * 余额沿用 tabular-nums，列表响应式（桌面表格 / 移动卡片）。
 */
export function AccountsPage() {
  const qc = useQueryClient();
  const query = useAccountBalances();
  const [filters, setFilters] = useState<AccountFilters>(DEFAULT_FILTERS);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [sortField, setSortField] = useState<SortField>("balance");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [visibleLimit, setVisibleLimit] = useState(20);

  const refresh = () =>
    void qc.invalidateQueries({ queryKey: ["account-balances"] });
  const data = query.data;

  const groups = useMemo(
    () => groupOptions(data?.accounts ?? []),
    [data],
  );
  const currencies = useMemo(
    () => uniqueCurrencies(data?.accounts ?? []),
    [data],
  );

  const visible = useMemo(() => {
    const filtered = applyFilters(
      financialAccounts(data?.accounts ?? []),
      filters,
    );
    return sortAccounts(filtered, sortField, sortDir);
  }, [data, filters, sortField, sortDir]);

  const visiblePage = visible.slice(0, visibleLimit);

  useEffect(() => {
    setVisibleLimit(20);
  }, [filters]);

  const activeFilterCount = useMemo(() => {
    let c = 0;
    if (filters.query) c++;
    if (filters.side !== "all") c++;
    if (filters.group) c++;
    if (filters.currency) c++;
    if (filters.includeInactive) c++;
    if (!filters.hideZeroInactive) c++;
    if (!filters.hideExcludedNetWorth) c++;
    return c;
  }, [filters]);

  const set = (patch: Partial<AccountFilters>) =>
    setFilters((f) => ({ ...f, ...patch }));

  const warnings = data?.missing_currencies?.length
    ? [
        `缺少汇率：${data.missing_currencies.join("、")}。相关账户无法折算 CNY。`,
      ]
    : [];

  const allFinancial = financialAccounts(data?.accounts ?? []);
  const base = data?.base_currency ?? "CNY";

  // 顶部汇总：资产 / 负债合计（精确 Decimal 域，仅可折算账户）。
  const totals = useMemo(() => {
    let assets = { units: 0n, scale: 0 };
    let liabilities = { units: 0n, scale: 0 };
    for (const a of allFinancial) {
      const d = a.balance_base !== null ? parseDecimal(a.balance_base) : null;
      if (!d) continue;
      if (a.type === "asset") assets = decSum([assets, d]);
      else liabilities = decSum([liabilities, d]);
    }
    return { assets, liabilities };
  }, [allFinancial]);

  useAppHeader({
    title: "账户",
    meta: data ? (
      <>
        <span>·</span>
        <span>数据日期 {formatDateCn(data.as_of)}</span>
      </>
    ) : undefined,
    actions: (
      <button type="button" className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]" onClick={refresh}>
        <RefreshCw size={15} aria-hidden="true" /> 刷新
      </button>
    ),
  });

  return (
    <div className="page accounts-page flex flex-col gap-[var(--space-5)] animate-none max-sm:min-w-0 max-sm:max-w-full max-md:[&_button:not(header_&)]:min-h-[var(--touch-target)] max-md:[&_input]:min-h-[var(--touch-target)] max-md:[&_input]:h-[var(--touch-target)] max-md:[&_select]:min-h-[var(--touch-target)] max-md:[&_select]:h-[var(--touch-target)]">
      {/* REL-05：报错时仍渲染缓存余额，必须先说明数据可能过期 */}
      <StaleDataBanner queries={[query]} onRefresh={refresh} />
      {query.error && (
        <ErrorBanner message={(query.error as Error).message} onRetry={refresh} />
      )}
      <WarningBanner items={warnings} onRefresh={refresh} />

      {/* 顶部汇总条 */}
      {!query.isPending && data && (
        <section
          aria-label="账户汇总"
          className="rounded-xl border border-[var(--hairline)] bg-[var(--card)] px-6 py-5 shadow-[0_1px_2px_rgba(11,46,39,0.04)]"
        >
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            <SummaryStat label="资产合计">
              <Amount value={formatDecimal(totals.assets)} currency={base} />
            </SummaryStat>
            <SummaryStat label="负债合计">
              <Amount value={formatDecimal(totals.liabilities)} currency={base} />
            </SummaryStat>
            <SummaryStat label="金融账户">
              <span className="text-[var(--foreground)] tabular-nums">
                {allFinancial.length}
                <span className="ml-1 text-[13px] font-normal text-[var(--delta-neutral)]">
                  个
                </span>
              </span>
            </SummaryStat>
          </div>
        </section>
      )}

      {/* 筛选面板收纳 */}
      <div className="mb-[var(--space-4)] w-full [.accounts-page_&]:mb-[var(--space-2)]">
        <button
          type="button"
          className={`inline-flex items-center gap-2 rounded-[10px] border border-[var(--border-default)] bg-[var(--topbar-bg)] px-3.5 py-2 text-[13px] font-medium text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)]${isFilterOpen ? " !bg-[var(--brand-tint)] !text-[var(--brand-deep)] !border-[var(--brand-border)]" : ""}`}
          onClick={() => setIsFilterOpen((prev) => !prev)}
          aria-expanded={isFilterOpen}
          aria-label="展开或收起账户筛选条件"
        >
          <Filter size={15} aria-hidden="true" />
          <span>筛选账户</span>
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] py-0 px-[5px] rounded-full bg-[var(--primary)] text-[#ffffff] text-[12px] font-semibold">{activeFilterCount}</span>
          )}
          <ChevronDown size={14} className="[transition:transform_180ms_ease] [.btn-filter-toggle.is-open_&]:[transform:rotate(180deg)]" aria-hidden="true" />
        </button>

        {isFilterOpen && (
          <Card
            variant="flat"
            className="account-filter-panel py-[var(--space-4)] px-[var(--space-5)] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] rounded-xl shadow-none mt-[var(--space-3)] max-md:[.accounts-page_&]:mt-[var(--space-2)]"
            noPadding
            ariaLabel="账户筛选"
            surface="solid"
          >
            <div className="filter-row grid [grid-template-columns:2fr_repeat(4,_1fr)] gap-[var(--space-3)] [align-items:end] max-[1439px]:[grid-template-columns:1fr_1fr_1fr] max-md:[grid-template-columns:1fr] [.filter-row+&]:mt-[var(--space-3)]">
              <label className="filter-field flex flex-col gap-1.5 [font:var(--type-caption)] text-[var(--text-muted)] [grid-column:1_/_-1]">
                <span className="label">搜索账户名称</span>
                <span className="search-box flex items-center gap-2 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] focus-within:border-[var(--brand-accent)] focus-within:shadow-[0_0_0_3px_rgba(40,_160,_111,_0.10)] [&_svg]:text-[var(--text-placeholder)] [&_svg]:shrink-0 [&_input]:border-0 [&_input]:outline-none [&_input]:flex-1 [&_input]:bg-transparent [&_input]:[font:400_14px/1_var(--font-family-base)] [&_input]:text-[var(--text-body)] [&_input::placeholder]:text-[var(--text-placeholder)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&_input]:h-full">
                  <Search size={16} aria-hidden="true" />
                  <input
                    type="search"
                    placeholder="按账户名称搜索..."
                    value={filters.query}
                    aria-label="搜索账户名称"
                    onChange={(e) => set({ query: e.target.value })}
                  />
                </span>
              </label>
              <label className="filter-field flex flex-col gap-1.5 [font:var(--type-caption)] text-[var(--text-muted)]">
                <span className="label">类型</span>
                <select
                  className="h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:400_14px/1_var(--font-family-base)] w-full [transition:border-color_var(--duration-hover)_var(--ease-standard),_box-shadow_var(--duration-hover)_var(--ease-standard)] focus:outline-none focus:border-[var(--brand-accent)] focus:shadow-[0_0_0_3px_rgba(40,_160,_111,_0.10)] max-md:[.transactions-page>.period-filter-row>&]:h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)]"
                  value={filters.side}
                  onChange={(e) =>
                    set({ side: e.target.value as AccountFilters["side"] })
                  }
                >
                  <option value="all">全部</option>
                  <option value="asset">资产</option>
                  <option value="liability">负债</option>
                </select>
              </label>
              <label className="filter-field flex flex-col gap-1.5 [font:var(--type-caption)] text-[var(--text-muted)]">
                <span className="label">分组</span>
                <select
                  className="h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:400_14px/1_var(--font-family-base)] w-full [transition:border-color_var(--duration-hover)_var(--ease-standard),_box-shadow_var(--duration-hover)_var(--ease-standard)] focus:outline-none focus:border-[var(--brand-accent)] focus:shadow-[0_0_0_3px_rgba(40,_160,_111,_0.10)] max-md:[.transactions-page>.period-filter-row>&]:h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)]"
                  value={filters.group}
                  onChange={(e) => set({ group: e.target.value })}
                >
                  <option value="">全部</option>
                  {groups.map((g) => (
                    <option key={g.key} value={g.key}>
                      {g.title}
                    </option>
                  ))}
                  <option value="pending">未分组</option>
                </select>
              </label>
              <label className="filter-field flex flex-col gap-1.5 [font:var(--type-caption)] text-[var(--text-muted)]">
                <span className="label">币种</span>
                <select
                  className="h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:400_14px/1_var(--font-family-base)] w-full [transition:border-color_var(--duration-hover)_var(--ease-standard),_box-shadow_var(--duration-hover)_var(--ease-standard)] focus:outline-none focus:border-[var(--brand-accent)] focus:shadow-[0_0_0_3px_rgba(40,_160,_111,_0.10)] max-md:[.transactions-page>.period-filter-row>&]:h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)]"
                  value={filters.currency}
                  onChange={(e) => set({ currency: e.target.value })}
                >
                  <option value="">全部</option>
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="filter-field flex flex-col gap-1.5 [font:var(--type-caption)] text-[var(--text-muted)]">
                <span className="label">排序</span>
                <select
                  className="h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:400_14px/1_var(--font-family-base)] w-full [transition:border-color_var(--duration-hover)_var(--ease-standard),_box-shadow_var(--duration-hover)_var(--ease-standard)] focus:outline-none focus:border-[var(--brand-accent)] focus:shadow-[0_0_0_3px_rgba(40,_160,_111,_0.10)] max-md:[.transactions-page>.period-filter-row>&]:h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)]"
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value as SortField)}
                >
                  <option value="balance">原币金额</option>
                  <option value="balanceBase">CNY 折算</option>
                  <option value="name">名称</option>
                </select>
              </label>
              <label className="filter-field flex flex-col gap-1.5 [font:var(--type-caption)] text-[var(--text-muted)]">
                <span className="label">方向</span>
                <select
                  className="h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:400_14px/1_var(--font-family-base)] w-full [transition:border-color_var(--duration-hover)_var(--ease-standard),_box-shadow_var(--duration-hover)_var(--ease-standard)] focus:outline-none focus:border-[var(--brand-accent)] focus:shadow-[0_0_0_3px_rgba(40,_160,_111,_0.10)] max-md:[.transactions-page>.period-filter-row>&]:h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)]"
                  value={sortDir}
                  onChange={(e) => setSortDir(e.target.value as SortDirection)}
                >
                  <option value="desc">从大到小</option>
                  <option value="asc">从小到大</option>
                </select>
              </label>
            </div>
            <div className="filter-row grid [grid-template-columns:2fr_repeat(4,_1fr)] gap-[var(--space-3)] [align-items:end] max-[1439px]:[grid-template-columns:1fr_1fr_1fr] max-md:[grid-template-columns:1fr] [.filter-row+&]:mt-[var(--space-3)]">
              <div className="filter-checks flex flex-wrap gap-[var(--space-4)] [font:var(--type-caption)] text-[var(--text-muted)] [&_label]:inline-flex [&_label]:items-center [&_label]:gap-1.5 max-md:[.accounts-page_&_label]:h-[var(--touch-target)] max-md:[.accounts-page_&_label]:min-h-[var(--touch-target)]">
                <label>
                  <input
                    type="checkbox"
                    checked={filters.includeInactive}
                    onChange={(e) =>
                      set({ includeInactive: e.target.checked })
                    }
                  />
                  显示停用账户
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={!filters.hideZeroInactive}
                    onChange={(e) =>
                      set({ hideZeroInactive: !e.target.checked })
                    }
                  />
                  显示停用且余额为零
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={!filters.hideExcludedNetWorth}
                    onChange={(e) =>
                      set({ hideExcludedNetWorth: !e.target.checked })
                    }
                  />
                  显示未计入净资产
                </label>
              </div>
            </div>
          </Card>
        )}
      </div>

      {query.isPending ? (
        <div className="h-[300px] animate-pulse rounded-xl bg-[var(--surface-subtle)]" />
      ) : (
        <>
          <p className="data-table-meta account-list-meta py-[var(--space-4)] px-[var(--space-5)] [font:var(--type-caption)] text-[var(--text-faint)] border-b border-b-[var(--border-soft)] m-0 p-0 bg-transparent border-b-0 [&_strong]:text-[var(--text-body)]">
            共 {allFinancial.length} 个金融账户，当前显示{" "}
            <strong>{visiblePage.length}</strong> 个 · 数据日期{" "}
            {data ? formatDateCn(data.as_of) : "—"}
          </p>

          {visible.length ? (
            <div className="account-list-content has-mobile-card mt-[var(--space-3)]">
              {/* PC 表格 */}
              <div className="data-table-wrap bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] overflow-hidden max-[479px]:overflow-x-auto max-[479px]:[-webkit-overflow-scrolling:touch] max-md:[.has-mobile-card_&]:hidden">
                <table
                  className="data-table account-table"
                  aria-label="账户余额"
                >
                  <thead>
                    <tr>
                      <th scope="col" className="col-name">
                        账户
                      </th>
                      <th scope="col" className="col-group">
                        分组 / 类型
                      </th>
                      <th scope="col" className="col-currency">
                        币种
                      </th>
                      <th scope="col" className="col-balance is-num [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">
                        原币余额
                      </th>
                      <th scope="col" className="col-converted is-num [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">
                        折合 {base}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePage.map((a) => (
                      <tr
                        key={a.id}
                        className={a.active ? "" : "row-inactive"}
                      >
                        <td data-label="账户">
                          <span className="account-name">
                            {a.name}
                            {!a.active && (
                              <span className="inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)] ml-1.5">停用</span>
                            )}
                            {!a.include_net_worth && (
                              <span className="inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)] ml-1.5">
                                不计净资产
                              </span>
                            )}
                          </span>
                          {isInvestmentAccount(a) && (
                            <DeepLink
                              label="在 Invest 中打开"
                              accountName={a.name}
                            />
                          )}
                        </td>
                        <td data-label="分组 / 类型">
                          <span>{a.group_title ?? "未分组"}</span>
                          <span className="my-0 mx-1.5 text-[var(--text-faint)]">·</span>
                          <span className="text-[var(--text-faint)]">
                            {a.type === "asset"
                              ? "资产"
                              : a.type === "liabilities" ||
                                  a.type === "liability"
                                ? "负债"
                                : a.type}
                          </span>
                        </td>
                        <td data-label="币种">{a.currency}</td>
                        <td data-label="原币余额" className="is-num [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                          <Amount value={a.balance} currency={a.currency} />
                        </td>
                        <td data-label={`折合 ${base}`} className="is-num [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                          {a.balance_base !== null ? (
                            <Amount value={a.balance_base} currency={base} />
                          ) : (
                            <span className="account-table-fx-missing text-[var(--danger-600)] leading-[18px]">
                              {a.currency} 汇率缺失，无法折算 {base}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 移动卡片列表（AccountCard 逻辑保留） */}
              <div
                className="hidden flex-col gap-3 w-full mt-3 mb-0 p-0 list-none max-md:flex max-md:[.accounts-page_&]:mt-0"
                role="group"
                aria-label="账户列表卡片视图"
              >
                {visiblePage.map((a) => (
                  <AccountCard key={a.id} account={a} baseCurrency={base} />
                ))}
              </div>

              {visiblePage.length < visible.length && (
                <div className="flex justify-center pt-[var(--space-3)]">
                  <button
                    type="button"
                    className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]"
                    onClick={() => setVisibleLimit((limit) => limit + 20)}
                  >
                    显示更多账户
                  </button>
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              title="没有符合条件的账户"
              description="请调整筛选条件或显示停用/未计入净资产账户。"
            />
          )}
        </>
      )}

      {/* REL-05/DATA-03：account-balances 只有 as_of（无 generated_at）。 */}
      <ReportTimestampFooter asOf={data?.as_of} />
    </div>
  );
}

/** 汇总格。 */
function SummaryStat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 sm:border-l sm:border-[var(--hairline)] sm:pl-6 first:sm:border-l-0 first:sm:pl-0">
      <span className="text-[12.5px] text-[var(--delta-neutral)]">{label}</span>
      <span className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--foreground)] tabular-nums">
        {children}
      </span>
    </div>
  );
}
