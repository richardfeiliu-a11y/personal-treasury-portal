import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EChart, exposureBarOption, fxAttributionOption, monthlyBarOption } from "../components/Chart";
import { CHART_COLORS } from "../utils/chartThemes";
import { compositionColor, compositionDonutOption, nwTrendOption } from "../utils/chartOptions";

const { setOptionMock, resizeMock, disposeMock } = vi.hoisted(() => ({
  setOptionMock: vi.fn(),
  resizeMock: vi.fn(),
  disposeMock: vi.fn(),
}));

// EChart 从 echarts/core 导入 init：只 mock init（保留真实 use() 注册），
// 避免在 jsdom 中走真实渲染路径。
vi.mock("echarts/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("echarts/core")>();
  return {
    ...actual,
    init: vi.fn(() => ({
      setOption: setOptionMock,
      resize: resizeMock,
      dispose: disposeMock,
    })),
  };
});

vi.mock("echarts", () => ({
  init: vi.fn(() => ({
    setOption: setOptionMock,
    resize: resizeMock,
    dispose: disposeMock,
  })),
}));

afterEach(() => {
  cleanup();
  setOptionMock.mockClear();
  resizeMock.mockClear();
  disposeMock.mockClear();
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("EChart component", () => {
  const baseOption = nwTrendOption([{ date: "2026-08-07", net_worth_base: "100" }]);

  it("initializes the chart once and applies the option", () => {
    render(createElement(EChart, { option: baseOption, height: 260, ariaLabel: "净资产趋势" }));
    expect(setOptionMock).toHaveBeenCalledTimes(1);
    expect(setOptionMock.mock.calls[0][0]).toMatchObject({ textStyle: { fontFamily: "Inter Variable, Inter, PingFang SC, sans-serif" } });
  });

  it("re-renders with a new option when the prop changes", () => {
    const { rerender } = render(createElement(EChart, { option: baseOption, height: 260, ariaLabel: "净资产趋势" }));
    // 传入新的 option 对象（引用变化）才会触发 setOption
    rerender(createElement(EChart, { option: { ...baseOption }, height: 260, ariaLabel: "净资产趋势" }));
    expect(setOptionMock).toHaveBeenCalledTimes(2);
  });

  it("resizes the chart on window resize", () => {
    render(createElement(EChart, { option: baseOption, height: 260, ariaLabel: "净资产趋势" }));
    window.dispatchEvent(new Event("resize"));
    expect(resizeMock).toHaveBeenCalledTimes(1);
  });

  it("disposes the chart on unmount", () => {
    const { unmount } = render(createElement(EChart, { option: baseOption, height: 260, ariaLabel: "净资产趋势" }));
    unmount();
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("applies dark overrides when data-theme is dark", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    render(createElement(EChart, { option: baseOption, height: 260, ariaLabel: "净资产趋势" }));
    expect(setOptionMock.mock.calls[0][0].tooltip.backgroundColor).toBe("#161b22");
    expect(setOptionMock.mock.calls[0][0].tooltip.borderColor).toBe("#30363d");
    expect(setOptionMock.mock.calls[0][0].xAxis.axisLabel.color).toBe("#8b949e");
  });

  it("renders a container with the requested height and aria label", () => {
    render(createElement(EChart, { option: baseOption, height: 320, ariaLabel: "测试图表" }));
    const el = document.querySelector('[role="img"]') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.style.height).toBe("320px");
    expect(el.getAttribute("aria-label")).toBe("测试图表");
  });
});

describe("chart theme", () => {
  it("uses the shared typography and motion settings for every chart option", () => {
    const options = [
      nwTrendOption([{ date: "2026-08-07", net_worth_base: "100" }]),
      fxAttributionOption([{ currency: "EUR", savings_contribution_cny: "100", fx_contribution_cny: "20" }]),
      exposureBarOption([{ currency: "EUR", cny_value: "100" }]),
      monthlyBarOption(["8月"], [100], [50]),
    ] as any[];

    for (const option of options) {
      expect(option.textStyle).toEqual({
        fontFamily: "Inter Variable, Inter, PingFang SC, sans-serif",
      });
      expect(option.animationDuration).toBe(220);
      expect(option.animationDurationUpdate).toBe(150);
      expect(option.media[0].query.maxWidth).toBe(640);
      expect(option.media[0].option.tooltip.triggerOn).toBe("click");
      expect(option.media[0].option.tooltip.alwaysShowContent).toBe(true);
    }
  });

  it("uses the approved warm-teal net-worth color", () => {
    const option = nwTrendOption([{ date: "2026-08-07", net_worth_base: "100" }]) as any;
    expect(option.color).toContain(CHART_COLORS.accent);
    expect(option.series[0].lineStyle.width).toBe(2);
  });

  it("labels the fx attribution savings series per spec §3.3", () => {
    const option = fxAttributionOption([{ currency: "EUR", savings_contribution_cny: "100", fx_contribution_cny: "20" }]) as any;
    expect(option.series[0].name).toBe("非汇率余额变动贡献");
    expect(option.series[0].data).toEqual([100]);
  });

  it("keeps income and expense semantic colors stable", () => {
    const option = monthlyBarOption(["8月"], [100], [50]) as any;
    expect(option.series[0].itemStyle.color).toBe(CHART_COLORS.positive);
    expect(option.series[1].itemStyle.color).toBe(CHART_COLORS.negative);
  });

  it("masks the goal label when masked is true", () => {
    const option = nwTrendOption([{ date: "2026-08-07", net_worth_base: "100" }], true, 100000) as any;
    expect(option.series[0].markLine.label.formatter).toBe("目标 ••••");
  });

  it("masks the y-axis ticks when masked is true", () => {
    // P0-1：遮蔽模式下趋势图 Y 轴刻度不得显示真实数字（与所有新图表函数一致）
    const option = nwTrendOption([{ date: "2026-08-07", net_worth_base: "100" }], true) as any;
    const fmt = option.yAxis.axisLabel.formatter;
    expect(fmt(100000)).toBe("••••");
    expect(fmt(100000)).not.toContain("100");
  });

  it("masks trend and monthly chart tooltips and axes without exposing fixture amounts", () => {
    const trend = nwTrendOption(
      [{ date: "2026-08-07", net_worth_base: "987654.32" }],
      true,
    ) as any;
    expect(trend.tooltip.valueFormatter(987654.32)).toBe("••••");
    expect(trend.tooltip.valueFormatter(987654.32)).not.toContain("987");

    const monthly = monthlyBarOption(["8月"], [876543.21], [765432.1], true) as any;
    expect(monthly.tooltip.valueFormatter(876543.21)).toBe("••••");
    expect(monthly.yAxis.axisLabel.formatter(876543.21)).toBe("••••");
    expect(JSON.stringify(monthly)).not.toContain("876,543");
  });

  it("keeps all visible ECharts labels at 12px or above", () => {
    const options = [
      nwTrendOption([{ date: "2026-08-07", net_worth_base: "100" }]),
      fxAttributionOption([{ currency: "EUR", savings_contribution_cny: "100", fx_contribution_cny: "20" }]),
      exposureBarOption([{ currency: "EUR", cny_value: "100" }]),
      monthlyBarOption(["8月"], [100], [50]),
    ] as any[];
    const sizes: number[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "fontSize" && typeof child === "number") sizes.push(child);
        else visit(child);
      }
    };
    options.forEach(visit);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((size) => size < 12)).toEqual([]);
  });

});


describe("nwTrendOption (C4 dynamic baseline)", () => {
  it("yAxis.min = dataMin * 0.9 (never zero-anchored)", () => {
    const points = [
      { date: "2026-01-31", net_worth_base: "100000.00" },
      { date: "2026-02-28", net_worth_base: "120000.00" },
      { date: "2026-03-31", net_worth_base: "110000.00" },
    ];
    const option = nwTrendOption(points) as any;
    // dataMin = 100000, yMin = 100000 * 0.9 = 90000
    expect(option.yAxis.min).toBeCloseTo(90000);
  });

  it("returns empty series for no data", () => {
    const option = nwTrendOption([]) as any;
    expect(option.series).toEqual([]);
  });

  it("handles null net_worth_base values", () => {
    const points = [
      { date: "2026-01-31", net_worth_base: null },
      { date: "2026-02-28", net_worth_base: "150000.00" },
    ];
    const option = nwTrendOption(points) as any;
    expect(option.yAxis.min).toBeCloseTo(135000);
  });

  it("renders a precise goal markLine when a goal is set", () => {
    const option = nwTrendOption(
      [{ date: "2026-02-28", net_worth_base: "150000.00" }],
      false,
      200000,
    ) as any;
    expect(option.series[0].markLine.data[0].yAxis).toBe(200000);
    expect(option.series[0].markLine.lineStyle.type).toBe("dashed");
    expect(option.series[0].markLine.label.formatter).toBe("目标 200,000.00");
  });
});

// ---------------------------------------------------------------------------
// Composition Analytics V1：donut option 兼容契约
// ---------------------------------------------------------------------------

describe("compositionDonutOption (V1)", () => {
  const slices = [
    { key: "a", label: "现金", amountText: "1500", value: 1500, color: compositionColor(0) },
    { key: "b", label: "投资", amountText: "800", value: 800, color: compositionColor(1) },
  ];

  it("shares the base option contract (font, animation, 640 mobile tooltip)", () => {
    const option = compositionDonutOption(slices, { masked: false, currency: "CNY", context: "total" }) as any;
    expect(option.textStyle).toEqual({
      fontFamily: "Inter Variable, Inter, PingFang SC, sans-serif",
    });
    expect(option.animationDuration).toBe(220);
    expect(option.media[0].query.maxWidth).toBe(640);
  });

  it("donut data carries authoritative amountText; option structure is expand-invariant", () => {
    // Top7+Other：Ranking 展开与否不影响 Donut series —— option 只由 slices 决定
    const withOther = compositionDonutOption(
      [...slices, { key: "other", label: "其他", amountText: "300", value: 300, color: compositionColor(-1) }],
      { masked: false, currency: "CNY", context: "total" },
    ) as any;
    expect(withOther.series[0].data).toHaveLength(3);
    expect(withOther.series[0].data[0].amountText).toBe("1500");
    expect(withOther.series).toHaveLength(1);
  });
});
