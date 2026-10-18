import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WaterfallChart } from "../components/WaterfallChart";
import { reconcileWaterfallData } from "../utils/waterfallReconciliation";
import type { ReportEnvelope } from "../api/types";

// 与 income-expense.test.tsx 一致：mock Chart 仅替换 EChart，保留 chartOptions 的纯函数。
vi.mock("../components/Chart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => <div role="img" aria-label={ariaLabel} />,
}));

function consistentReport(): ReportEnvelope {
  return {
    schema_version: "1.0",
    report_id: "test-ie",
    report_type: "income_statement",
    generated_at: "2026-08-09T00:00:00+00:00",
    base_currency: "CNY",
    period: { start_date: "2026-08-01", end_date: "2026-08-31" },
    fx_complete: true,
    data_complete: true,
    warnings: [],
    summary: {
      total_income_cny: "20000",
      total_expenses_cny: "8500",
      net_result_cny: "11500",
    },
    sections: [
      {
        key: "income",
        title: "收入",
        rows: [{ label: "工资", currency: "CNY", amount: "20000", amount_base: "20000", count: 1 }],
        subtotal_base: "20000",
      },
      {
        key: "expenses",
        title: "支出",
        rows: [
          { label: "房租", currency: "CNY", amount: "4000", amount_base: "4000", count: 1 },
          { label: "餐饮", currency: "CNY", amount: "2500", amount_base: "2500", count: 10 },
          { label: "交通", currency: "CNY", amount: "1000", amount_base: "1000", count: 5 },
          { label: "娱乐", currency: "CNY", amount: "600", amount_base: "600", count: 3 },
          { label: "其他", currency: "CNY", amount: "400", amount_base: "400", count: 2 },
        ],
        subtotal_base: "8500",
      },
    ],
  };
}

describe("WaterfallChart", () => {
  it("门禁未通过时渲染阻断态，绝不渲染图表", () => {
    const blocked = reconcileWaterfallData({
      ...consistentReport(),
      summary: { total_income_cny: "20000", total_expenses_cny: "8500", net_result_cny: "9999" },
    });
    expect(blocked.is_complete).toBe(false);
    render(<WaterfallChart data={blocked} baseCurrency="CNY" />);
    expect(screen.getByText("瀑布图已阻断")).toBeInTheDocument();
    expect(screen.getByText(blocked.error ?? "")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "收支瀑布图" })).not.toBeInTheDocument();
  });

  it("门禁通过时渲染图表（收支瀑布图）", () => {
    const ok = reconcileWaterfallData(consistentReport());
    expect(ok.is_complete).toBe(true);
    render(<WaterfallChart data={ok} baseCurrency="CNY" />);
    expect(screen.getByRole("img", { name: "收支瀑布图" })).toBeInTheDocument();
    expect(screen.queryByText("瀑布图已阻断")).not.toBeInTheDocument();
  });
});
