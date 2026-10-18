// 与 Bridge 接口契约一一对应的类型（金额一律为字符串 Decimal）

export interface WebAccountRow {
  id: string;
  name: string;
  currency: string;
  balance_native: string;
  balance_base: string | null;
  active: boolean;
  include_net_worth: boolean;
}

export interface WebAccountGroup {
  key: string;
  title: string;
  side: "asset" | "liability";
  subtotal_base: string | null;
  accounts: WebAccountRow[];
}

export interface BalanceSheetSummary {
  total_assets_base: string | null;
  total_liabilities_base: string | null;
  net_worth_base: string | null;
  included_account_count: number;
  pending_mapping_count: number;
}

export interface PersonalBalanceSheet {
  schema_version: string;
  source: string;
  generated_at: string;
  base_currency: string;
  balance_as_of: string;
  fx_complete: boolean;
  missing_currencies: string[];
  warnings: string[];
  summary: BalanceSheetSummary;
  groups: WebAccountGroup[];
}

export interface NetWorthTrendPoint {
  date: string;
  total_assets_base: string | null;
  total_liabilities_base: string | null;
  net_worth_base: string | null;
  fx_complete: boolean;
  missing_currencies: string[];
}

export interface NetWorthTrend {
  schema_version: string;
  base_currency: string;
  as_of: string;
  months: number;
  points: NetWorthTrendPoint[];
}

export interface ReportSectionRow {
  label: string;
  currency: string;
  amount: string;
  amount_base: string | null;
  count: number | null;
  extra?: Record<string, unknown>;
}

export interface ReportSection {
  key: string;
  title: string;
  rows: ReportSectionRow[];
  subtotal_base: string | null;
}

/** income_statement 的 summary 契约（spec §5.2 类型收紧；金额为 Decimal string）。 */
export interface IncomeStatementSummary extends Record<string, unknown> {
  accounting_view?: "native" | "management";
  total_income_cny: string | null;
  total_expenses_cny: string | null;
  net_result_cny: string | null;
  savings_rate_pct: string | null;
  missing_currencies?: string[];
}

export interface ReportEnvelope<Summary extends Record<string, unknown> = Record<string, unknown>> {
  schema_version: string;
  report_id: string;
  report_type: string;
  generated_at: string;
  base_currency: string;
  period?: { start_date: string; end_date: string } | null;
  /** 后端 envelope 实际携带；optional 以兼容旧 fixture（spec §5.2）。 */
  accounting_view?: "native" | "management";
  fx_complete: boolean;
  data_complete: boolean;
  warnings: string[];
  summary: Summary;
  sections: ReportSection[];
}

/** expense_breakdown 的 summary 契约（后端 expense_breakdown.py:162-176）。 */
export interface ExpenseBreakdownSummary extends Record<string, unknown> {
  accounting_view?: "native" | "management";
  top_n?: number;
  /** 缺汇率时为 false：此时按币种分别排名，无全局 Top N。 */
  global_ranking_available?: boolean;
  ranking_basis?: "cny" | "per_currency";
  total_expenses_cny?: string | null;
  compare_period?: { start_date: string; end_date: string } | null;
  compare_total_expenses_cny?: string | null;
  candidate_categories?: number;
  unclassified_count?: number;
  missing_currencies?: string[];
}

export interface AccountBalanceRow {
  id: string;
  name: string;
  type: string;
  currency: string;
  balance: string;
  active: boolean;
  account_role: string | null;
  include_net_worth: boolean;
  group: string | null;
  group_title: string | null;
  balance_base: string | null;
  fx_rate_date: string | null;
  fx_source: string | null;
}

export interface AccountBalances {
  base_currency: string;
  as_of: string;
  fx_complete: boolean;
  missing_currencies: string[];
  accounts: AccountBalanceRow[];
}

export type Side = "asset" | "liability";

export interface FxAttributionRow {
  currency: string;
  /** Decimal string, e.g. "1234.56" */
  start_balance: string;
  /** Decimal string, e.g. "1234.56" */
  end_balance: string;
  start_rate: number;
  end_rate: number;
  /** Decimal string, e.g. "1234.56" */
  savings_contribution_cny: string;
  /** Decimal string, e.g. "1234.56" */
  fx_contribution_cny: string;
  /** Decimal string, e.g. "1234.56" */
  net_change_cny: string;
}

export interface FxAttribution {
  schema_version: string;
  period_from: string;
  period_to: string;
  /** Decimal string, e.g. "1234.56" */
  total_net_worth_change_cny: string;
  /** Decimal string, e.g. "1234.56" */
  total_savings_contribution_cny: string;
  /** Decimal string, e.g. "1234.56" */
  total_fx_contribution_cny: string;
  fx_contribution_percentage: number;
  by_currency: FxAttributionRow[];
  notes: string[];
}

export interface SpendingTrendRow {
  category: string;
  /** Decimal string, e.g. "1234.56"; 汇率不完整时为 null */
  current_month_amount: string | null;
  /** Decimal string, e.g. "1234.56"; 汇率不完整时为 null */
  historical_monthly_average: string | null;
  /** 偏差百分比；汇率不完整时为 null */
  deviation_percentage: number | null;
  /** 行级汇率完整性：false 表示存在非零交易缺汇率，金额为 null */
  fx_complete: boolean;
  missing_currencies: string[];
  anomaly: boolean;
}

export interface SpendingTrends {
  schema_version: string;
  as_of: string;
  current_month: string;
  comparison_window_months: number;
  base_currency: "CNY";
  fx_complete: boolean;
  missing_currencies: string[];
  categories_count: number;
  anomalies_count: number;
  trends: SpendingTrendRow[];
}

export interface CurrencyExposureRow {
  currency: string;
  /** Decimal string, e.g. "1234.56" */
  balance: string;
  /** Decimal string, e.g. "1234.56" */
  cny_value: string | null;
  percentage: number | null;
}

export interface CurrencyExposure {
  schema_version: string;
  base_currency: string;
  /** Decimal string, e.g. "1234.56" */
  total_net_worth_cny: string | null;
  fx_rates_date: string;
  fx_complete: boolean;
  missing_currencies: string[];
  exposures: CurrencyExposureRow[];
}

export interface TransactionRow {
  date: string;
  type: string;
  description: string;
  category: string;
  source: string;
  destination: string;
  /** Decimal string, e.g. "1234.56" */
  amount_native: string;
  currency: string;
  /** Decimal string, e.g. "1234.56" */
  amount_base: string | null;
  fx_exact: boolean;
  tags: string[];
  journal_id: string;
}

export interface Transactions {
  schema_version: string;
  period_from: string;
  period_to: string;
  total: number;
  offset: number;
  limit: number;
  rows: TransactionRow[];
  fx_notes: string[];
}

export interface AnomalyRow {
  /** 确定性稳定 ID（spec A.1）：spending_trend:{category}:{month} / health:{name} */
  id: string;
  source: string;
  severity: "critical" | "warning" | "info";
  message: string;
  /** 明确分类名称（无则为 null，严禁前端正则解析 message） */
  category: string | null;
  /** Decimal string, e.g. "1234.56"；以 currency 为准 */
  amount: string | null;
  currency: string | null;
}

export interface Anomalies {
  schema_version: string;
  checked_at: string;
  count: number;
  anomalies: AnomalyRow[];
}
