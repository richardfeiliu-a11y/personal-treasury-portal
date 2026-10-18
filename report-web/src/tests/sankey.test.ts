import { describe, expect, it } from "vitest";
import type { ReportEnvelope } from "../api/types";
import { buildSankeyOption } from "../utils/sankeyOptions";

const BASE = "CNY";

/** 构造最小可用的 ReportEnvelope（income-statement 真实契约），其余字段给安全默认值。 */
function makeEnvelope(partial: Partial<ReportEnvelope>): ReportEnvelope {
  return {
    schema_version: "1.0",
    report_id: "sankey-test",
    report_type: "income_statement",
    generated_at: "2026-08-09T10:00:00+00:00",
    base_currency: BASE,
    fx_complete: true,
    data_complete: true,
    warnings: [],
    summary: {},
    sections: [],
    ...partial,
  } as ReportEnvelope;
}

/** 含 top_expenses 且两行 amount_base 均非 null 的有效回包。 */
function validReport(): ReportEnvelope {
  return makeEnvelope({
    fx_complete: true,
    summary: {
      total_income_cny: "10000.00",
      total_expenses_cny: "8000.00",
      net_result_cny: "2000.00",
    },
    sections: [
      {
        key: "top_expenses",
        title: "前 N 大费用",
        rows: [
          { label: "居住", currency: "CNY", amount: "4000.00", amount_base: "4000.00", count: 1 },
          { label: "餐饮", currency: "CNY", amount: "4000.00", amount_base: "4000.00", count: 23 },
        ],
        subtotal_base: "8000.00",
      },
    ],
  });
}

describe("buildSankeyOption", () => {
  it("有效回包返回非 null，节点含总收入且存在连线", () => {
    const opt = buildSankeyOption(validReport());
    expect(opt).not.toBeNull();
    const series = (opt as any).series[0];
    const names = series.data.map((n: any) => n.name);
    // 节点标签嵌入原始金额小数串 + 币种，不带千分位（精确格式断言）。
    expect(names).toContain("总收入 (10000.00 CNY)");
    expect(names).toContain("居住 (4000.00 CNY)");
    expect(names).toContain("餐饮 (4000.00 CNY)");
    expect(names).toContain("结余 (2000.00 CNY)");
    expect(series.links.length).toBeGreaterThan(0);
  });

  it("总收入→结余连线数值等于 Number(net_result_cny)", () => {
    const opt = buildSankeyOption(validReport());
    const series = (opt as any).series[0];
    const netLink = series.links.find((l: any) => l.target === "结余 (2000.00 CNY)");
    expect(netLink).toBeDefined();
    expect(netLink.value).toBe(2000);
  });

  it("fx_complete 为 false 时返回 null（优雅降级）", () => {
    const report = makeEnvelope({
      fx_complete: false,
      summary: { total_income_cny: "10000.00", net_result_cny: "2000.00" },
      sections: [
        {
          key: "top_expenses",
          title: "前 N 大费用",
          rows: [
            { label: "居住", currency: "CNY", amount: "4000.00", amount_base: "4000.00", count: 1 },
            { label: "餐饮", currency: "CNY", amount: "4000.00", amount_base: "4000.00", count: 23 },
          ],
          subtotal_base: "8000.00",
        },
      ],
    });
    expect(buildSankeyOption(report)).toBeNull();
  });

  it("top_expenses 行 amount_base 全为 null（有效连线 < 2）时返回 null", () => {
    const report = makeEnvelope({
      fx_complete: true,
      summary: { total_income_cny: "10000.00", net_result_cny: "2000.00" },
      sections: [
        {
          key: "top_expenses",
          title: "前 N 大费用",
          rows: [
            { label: "居住", currency: "CNY", amount: "4000.00", amount_base: null, count: 1 },
            { label: "餐饮", currency: "CNY", amount: "4000.00", amount_base: null, count: 23 },
          ],
          subtotal_base: null,
        },
      ],
    });
    expect(buildSankeyOption(report)).toBeNull();
  });

  it("找不到 top_expenses 节时返回 null", () => {
    const report = makeEnvelope({
      fx_complete: true,
      summary: { total_income_cny: "10000.00", net_result_cny: "2000.00" },
      sections: [{ key: "income", title: "收入", rows: [], subtotal_base: "10000.00" }],
    });
    expect(buildSankeyOption(report)).toBeNull();
  });
});
