/**
 * SpendingDeviationTable：支出偏差桌（category | MTD | historical avg | deviation）
 * spec section 10 内容 #2。从旧 Trends 抽取为可复用组件，桌面为 data-table，
 * 移动端为两行 KV 卡片（C3/ALIGN-06）。类名 .trends-category-* 由 e2e 契约锁定。
 *
 * 金钱契约：null 金额渲染 "汇率缺失" 而非 0；FX 不完整行显式缺汇率标签。
 */
import type { SpendingTrendRow } from "../api/types";
import { Amount } from "./Amount";
import { ResponsiveDataView } from "./ResponsiveDataView";
import { formatPct } from "../utils/format";

export interface SpendingDeviationTableProps {
  rows: SpendingTrendRow[];
}

export function SpendingDeviationTable({ rows }: SpendingDeviationTableProps) {
  return (
    <ResponsiveDataView
      isEmpty={rows.length === 0}
      emptyTitle="暂无支出数据"
      emptyDescription="本月或历史窗口内没有支出记录。"
      desktop={
        <div className="data-table-wrap trends-category-desktop bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] overflow-hidden max-[479px]:overflow-x-auto max-[479px]:[-webkit-overflow-scrolling:touch] max-md:[.has-mobile-card_&]:hidden max-md:hidden">
          <table className="data-table" aria-label="支出趋势">
            <thead>
              <tr>
                <th>类别</th>
                <th className="is-num [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">本月支出</th>
                <th className="is-num [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">历史月均</th>
                <th className="is-num [.data-table_thead_&]:[font-variant-numeric:tabular-nums]">偏差</th>
                <th>异常</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.category}>
                  <td>
                    {r.category}
                    {!r.fx_complete && <span className="inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)] bg-[var(--warning-100)] text-[var(--warning-800)] border-[var(--warning-100)]">缺汇率</span>}
                  </td>
                  <td className="is-num [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                    {r.current_month_amount == null
                      ? "汇率缺失"
                      : <Amount value={r.current_month_amount} currency="CNY" />}
                  </td>
                  <td className="is-num [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                    {r.historical_monthly_average == null
                      ? "汇率缺失"
                      : <Amount value={r.historical_monthly_average} currency="CNY" />}
                  </td>
                  <td className="is-num [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">{formatPct(r.deviation_percentage)}</td>
                  <td>{r.anomaly ? "⚠ 是" : "否"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
      mobile={
        <ul className="trends-category-mobile mobile-card-list hidden flex-col gap-3 w-full mt-3 mb-0 p-0 list-none max-md:flex max-md:[.accounts-page_&]:mt-0 max-md:mt-0" aria-label="支出趋势类别卡片">
          {rows.map((r) => (
            <li key={r.category} className="trends-category-card bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl py-3.5 px-4 flex flex-col gap-2.5 shadow-[var(--shadow-sm)] max-sm:min-w-0 max-sm:max-w-full">
              <div className="flex items-center justify-between gap-2 border-b border-b-[var(--border-soft)] pb-2.5 cursor-default [.income-top-card_&]:mb-0">
                <span className="min-w-0 text-[var(--text-strong)] [font:var(--type-body)] font-semibold [overflow-wrap:anywhere]">{r.category}</span>
                <span className="mobile-card-header-tags">
                  {!r.fx_complete && <span className="inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)] bg-[var(--warning-100)] text-[var(--warning-800)] border-[var(--warning-100)]">缺汇率</span>}
                  <span className={"tag " + (r.anomaly ? "tag-warn" : "")}>
                    {r.anomaly ? "异常" : "正常"}
                  </span>
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-[var(--space-3)] [font:var(--type-body)] leading-[22px]">
                  <span className="text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal">本月支出</span>
                  <span className="text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                    {r.current_month_amount == null
                      ? "汇率缺失"
                      : <Amount value={r.current_month_amount} currency="CNY" />}
                  </span>
                </div>
                <div className="flex items-start justify-between gap-[var(--space-3)] [font:var(--type-body)] leading-[22px]">
                  <span className="text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal">历史月均</span>
                  <span className="text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                    {r.historical_monthly_average == null
                      ? "汇率缺失"
                      : <Amount value={r.historical_monthly_average} currency="CNY" />}
                  </span>
                </div>
                <div className="flex items-start justify-between gap-[var(--space-3)] [font:var(--type-body)] leading-[22px]">
                  <span className="text-[var(--text-faint)] max-sm:[overflow-wrap:anywhere] max-sm:break-normal">偏差</span>
                  <span className="text-[var(--text-body)] font-medium text-right [overflow-wrap:anywhere] max-sm:break-normal [.fx-currency-row_&]:ml-[auto] [.fx-currency-row_&]:text-right [.fx-currency-row_&]:[font-variant-numeric:tabular-nums] [.fx-currency-details_&]:ml-[auto] [.fx-currency-details_&]:text-right [.fx-currency-details_&]:[font-variant-numeric:tabular-nums] [.data-table_tbody_&]:[font-variant-numeric:tabular-nums]">
                    {formatPct(r.deviation_percentage)}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      }
    />
  );
}
