import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ReportTimestampFooter } from "../components/ReportTimestampFooter";
import { MaskProvider } from "../components/MaskContext";

describe("ReportTimestampFooter (ALIGN-10)", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("renders Europe/Berlin timestamp for a valid ISO date", () => {
    render(<ReportTimestampFooter generatedAt="2026-08-18T14:30:00Z" />);
    const footer = screen.getByTestId("report-timestamp-footer");
    // UTC 14:30 → Europe/Berlin 16:30 (CEST, UTC+2 in August)
    expect(footer).toHaveTextContent("数据生成时间:");
    expect(footer).toHaveTextContent("(Europe/Berlin)");
    // Should contain the date part
    expect(footer).toHaveTextContent("2026-08-18");
  });

  it("renders em-dash when generatedAt is null", () => {
    render(<ReportTimestampFooter generatedAt={null} />);
    expect(screen.getByTestId("report-timestamp-footer")).toHaveTextContent("—");
  });

  it("renders em-dash when generatedAt is undefined", () => {
    render(<ReportTimestampFooter generatedAt={undefined} />);
    expect(screen.getByTestId("report-timestamp-footer")).toHaveTextContent("—");
  });

  it("renders em-dash for invalid date string", () => {
    render(<ReportTimestampFooter generatedAt="not-a-date" />);
    expect(screen.getByTestId("report-timestamp-footer")).toHaveTextContent("—");
  });

  it("does NOT use ¥ prefix (C9/ALIGN-02 compliance)", () => {
    render(<ReportTimestampFooter generatedAt="2026-08-18T14:30:00Z" />);
    const footer = screen.getByTestId("report-timestamp-footer");
    expect(footer.textContent).not.toContain("¥");
  });

  // -------------------------------------------------------------------------
  // REL-05：各页真实 data 形态（instant / 纯日历日 / 两者兼有 / 缺失）
  // -------------------------------------------------------------------------

  it("balance 形态：generated_at 与 balance_as_of 同时披露", () => {
    render(<ReportTimestampFooter generatedAt="2026-08-09T10:00:00+00:00" asOf="2026-08-09" />);
    const footer = screen.getByTestId("report-timestamp-footer");
    expect(footer).toHaveTextContent("数据生成时间: 2026-08-09 12:00 (Europe/Berlin)");
    expect(footer).toHaveTextContent("数据截止: 2026-08-09");
  });

  it("纯日历日（as_of / balance_as_of）只回显日期，不臆造时分", () => {
    render(<ReportTimestampFooter asOf="2026-08-09" />);
    const footer = screen.getByTestId("report-timestamp-footer");
    expect(footer).toHaveTextContent("数据截止: 2026-08-09");
    expect(footer.textContent).not.toMatch(/\d{2}:\d{2}/);
    // 日历日不得被当成 UTC 瞬间而偏移到前一天
    expect(footer.textContent).not.toContain("2026-08-08");
  });

  it("trend / anomalies 形态：as_of 与 checked_at 各自驱动对应槽位", () => {
    render(<ReportTimestampFooter generatedAt="2026-09-01T21:05:00+00:00" asOf="2026-08-31" />);
    const footer = screen.getByTestId("report-timestamp-footer");
    // UTC 21:05 → 柏林 23:05（CEST）
    expect(footer).toHaveTextContent("数据生成时间: 2026-09-01 23:05 (Europe/Berlin)");
    expect(footer).toHaveTextContent("数据截止: 2026-08-31");
  });

  it("无 generated_at 端点形态：仅 as_of，不显示「数据生成时间」空位", () => {
    render(<ReportTimestampFooter generatedAt={undefined} asOf="2026-08-31" />);
    const footer = screen.getByTestId("report-timestamp-footer");
    expect(footer).toHaveTextContent("数据截止: 2026-08-31");
    expect(footer.textContent).not.toContain("数据生成时间");
  });

  it("非法日历日（2026-02-30 / 带时间的串）视为缺失", () => {
    render(<ReportTimestampFooter asOf="2026-02-30" />);
    expect(screen.getByTestId("report-timestamp-footer")).toHaveTextContent("—");
    cleanup();
    render(<ReportTimestampFooter asOf="2026-08-09T10:00:00+00:00" />);
    expect(screen.getByTestId("report-timestamp-footer")).toHaveTextContent("—");
  });

  it("结构白名单：任意输入组合下页脚只可能是时间戳文案（遮蔽模式的不变量）", () => {
    const shapes: { generatedAt?: string | null; asOf?: string | null }[] = [
      { generatedAt: "2026-08-09T10:00:00+00:00", asOf: "2026-08-09" },
      { generatedAt: "2026-08-09T10:00:00+00:00" },
      { asOf: "2026-08-31" },
      { generatedAt: null, asOf: undefined },
      { generatedAt: "2026-09-01T21:05:00Z", asOf: "bad-input" },
    ];
    const allowed =
      /^(—|数据生成时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Europe\/Berlin\)( · 数据截止: \d{4}-\d{2}-\d{2})?|数据截止: \d{4}-\d{2}-\d{2})$/;
    for (const shape of shapes) {
      render(<ReportTimestampFooter {...shape} />);
      const text = screen.getByTestId("report-timestamp-footer").textContent ?? "";
      expect(text).toMatch(allowed);
      cleanup();
    }
  });

  it("遮蔽模式下 Footer 只有时间戳：不泄漏金额且与未遮蔽输出一致", () => {
    window.localStorage.setItem("report-web.mask", "1");
    const { unmount } = render(
      <MaskProvider>
        <ReportTimestampFooter generatedAt="2026-08-09T10:00:00+00:00" asOf="2026-08-09" />
      </MaskProvider>,
    );
    const maskedText = screen.getByTestId("report-timestamp-footer").textContent;
    unmount();

    window.localStorage.setItem("report-web.mask", "0");
    render(
      <MaskProvider>
        <ReportTimestampFooter generatedAt="2026-08-09T10:00:00+00:00" asOf="2026-08-09" />
      </MaskProvider>,
    );
    const plainText = screen.getByTestId("report-timestamp-footer").textContent;

    expect(maskedText).toBe(plainText);
    // 仅日期与时间数字，无币种/金额/遮蔽符号
    expect(maskedText).toBe("数据生成时间: 2026-08-09 12:00 (Europe/Berlin) · 数据截止: 2026-08-09");
    expect(maskedText).not.toContain("CNY");
    expect(maskedText).not.toContain("•");
  });
});
