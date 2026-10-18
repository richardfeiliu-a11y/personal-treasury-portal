// WP3：Composition 共享组件测试（spec §10.3）。
// EChart 按仓内惯例 mock（同 waterfall-chart.test.tsx），chartOptions 保持纯函数直测。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/ChartWrapper", () => ({
  EChart: ({ ariaLabel, height }: { ariaLabel: string; height?: number | string }) => (
    <div role="img" aria-label={ariaLabel} data-testid="echart" data-height={String(height)} />
  ),
}));

const { maskState } = vi.hoisted(() => ({ maskState: { masked: false } }));
vi.mock("../components/MaskContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/MaskContext")>();
  return {
    ...actual,
    useMask: () => ({ masked: maskState.masked, toggleMask: () => {} }),
  };
});

import { compositionColor, compositionDonutOption } from "../utils/chartOptions";
import { CompositionCard } from "../components/composition/CompositionCard";
import { CompositionDonut } from "../components/composition/CompositionDonut";
import {
  CompositionRanking,
  type RankingItem,
  type RowAction,
} from "../components/composition/CompositionRanking";
import {
  CompositionFilterControl,
  type FilterOption,
} from "../components/composition/CompositionFilterControl";
import { CompositionOffsetBlock } from "../components/composition/CompositionOffsetBlock";
import { CompositionFxBlocked } from "../components/composition/CompositionFxBlocked";
import type { SelectionState } from "../utils/compositionSeries";

afterEach(() => {
  cleanup();
  maskState.masked = false;
});

const CNY = "CNY";

// ---------------------------------------------------------------------------
// compositionDonutOption（纯函数）
// ---------------------------------------------------------------------------

describe("compositionDonutOption", () => {
  const slices = [
    { key: "a", label: "现金", amountText: "1500", value: 1500, color: "#2F8F68" },
    { key: "b", label: "投资", amountText: "800", value: 800, color: "#D9A441" },
  ];

  it("builds one pie datum per slice with per-slice colors and white border", () => {
    const option = compositionDonutOption(slices, { masked: false, currency: CNY, context: "total" }) as any;
    const series = option.series[0];
    expect(series.type).toBe("pie");
    expect(series.data).toHaveLength(2);
    expect(series.data[0].itemStyle.color).toBe("#2F8F68");
    expect(series.itemStyle.borderColor).toBe("#FFFFFF");
  });

  it("keeps authoritative amountText in tooltip and masks only the amount when masked", () => {
    const odd = [
      { key: "a", label: "餐饮", amountText: "0.3", value: 0.3, color: "#2F8F68" },
    ];
    const masked = compositionDonutOption(odd, { masked: true, currency: CNY, context: "total" }) as any;
    const maskedText = masked.tooltip.formatter({ name: "餐饮", value: 0.3, percent: 100, data: odd[0] });
    expect(maskedText).toContain("••••");
    expect(maskedText).toContain("100.0%");
    expect(maskedText).not.toContain("0.3");

    const unmasked = compositionDonutOption(odd, { masked: false, currency: CNY, context: "total" }) as any;
    const text = unmasked.tooltip.formatter({ name: "餐饮", value: 0.30000000000000004, percent: 100, data: odd[0] });
    expect(text).toContain("0.3"); // 权威 amountText，不经浮点回环
    expect(text).toContain("100.0%");
  });

  it("uses mobile vs desktop radius and reports filtered denominator wording", () => {
    const mobile = compositionDonutOption(slices, { masked: false, currency: CNY, context: "filtered", mobile: true }) as any;
    expect(mobile.series[0].radius).toEqual(["50%", "70%"]);
    const desktop = compositionDonutOption(slices, { masked: false, currency: CNY, context: "total" }) as any;
    expect(desktop.series[0].radius).toEqual(["52%", "72%"]);
  });

  it("supports a single slice as a full ring (geometry invariant: series length constant)", () => {
    const single = compositionDonutOption(
      [slices[0]], { masked: false, currency: CNY, context: "total" },
    ) as any;
    expect(single.series[0].data).toHaveLength(1);
    expect(single.series).toHaveLength(1);
  });

  it("compositionColor cycles the allocation palette; -1 is neutral grey for Other", () => {
    expect(compositionColor(0)).toBe("#157A5A");
    expect(compositionColor(6)).toBe(compositionColor(0)); // 第 7 项循环
    expect(compositionColor(-1)).toBe("#8A93A0");
  });
});

// ---------------------------------------------------------------------------
// CompositionCard
// ---------------------------------------------------------------------------

describe("CompositionCard", () => {
  it("renders ready two-column layout with slots in order", () => {
    render(
      <CompositionCard
        ariaLabel="资产构成分析"
        controls={<button>控件</button>}
        context={<p>截至 2026-08-22</p>}
        chart={<div data-testid="chart" />}
        ranking={<div data-testid="ranking" />}
        footer={<div data-testid="footer" />}
      />,
    );
    const card = screen.getByLabelText("资产构成分析");
    expect(card).toBeTruthy();
    expect(card.getAttribute("aria-busy")).toBeNull();
    const order = [
      screen.getByTestId("chart").compareDocumentPosition(screen.getByTestId("ranking")),
    ];
    expect(order[0] & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // chart before ranking
    expect(screen.getByTestId("footer")).toBeTruthy();
    expect(screen.getByText("截至 2026-08-22")).toBeTruthy();
    expect(screen.getByText("构成分析")).toBeTruthy(); // default title
  });

  it("renders children as single panel for blocked/empty states", () => {
    render(
      <CompositionCard ariaLabel="支出构成分析" controls={<span />}>
        <div data-testid="blocked">暂不可用</div>
      </CompositionCard>,
    );
    expect(screen.getByTestId("blocked")).toBeTruthy();
  });

  it("marks busy state", () => {
    render(
      <CompositionCard ariaLabel="x" controls={<span />} busy>
        <div />
      </CompositionCard>,
    );
    expect(screen.getByLabelText("x").getAttribute("aria-busy")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// CompositionDonut（EChart mocked）
// ---------------------------------------------------------------------------

describe("CompositionDonut", () => {
  const slices = [
    { key: "a", label: "现金", amountText: "1500", value: 1500, color: "#2F8F68" },
    { key: "b", label: "投资", amountText: "800", value: 800, color: "#D9A441" },
  ];

  it("renders DOM center amount (masked by MaskContext) and caption", () => {
    render(
      <CompositionDonut
        slices={slices}
        centerAmount="2300"
        centerLabel="总资产"
        currency={CNY}
        caption="截至 2026-08-22"
        tooltipContext="total"
        ariaLabel="资产构成：现金 1500，投资 800，中心 2300"
      />,
    );
    const center = screen.getByText("总资产").closest(".comp-donut-center");
    expect(center).toBeTruthy();
    expect(center!.textContent).toContain("2,300");
    expect(screen.getByText("截至 2026-08-22")).toBeTruthy();
  });

  it("replaces aria-label with 金额已遮蔽 when masked; keeps labels when unmasked", () => {
    const props = {
      slices,
      centerAmount: "2300",
      centerLabel: "总资产",
      currency: CNY,
      caption: "截至",
      tooltipContext: "total" as const,
      ariaLabel: "资产构成：现金 1500，投资 800，中心 2300",
    };
    maskState.masked = true;
    const { unmount } = render(<CompositionDonut {...props} />);
    const chart = screen.getByTestId("echart");
    expect(chart.getAttribute("aria-label")).toContain("金额已遮蔽");
    expect(chart.getAttribute("aria-label")).not.toContain("1500");
    unmount();

    maskState.masked = false;
    render(<CompositionDonut {...props} />);
    expect(screen.getByTestId("echart").getAttribute("aria-label")).toContain("1500");
  });
});

// ---------------------------------------------------------------------------
// CompositionRanking
// ---------------------------------------------------------------------------

describe("CompositionRanking", () => {
  const items: RankingItem[] = [
    { key: "a", label: "现金", amountText: "1500", percentage: 65.2, colorIndex: 0 },
    { key: "b", label: "投资", amountText: "800", percentage: 34.8, colorIndex: 1 },
  ];

  it("renders button rows activated by click and Enter/Space", () => {
    const onActivate = vi.fn();
    const actionFor = (item: RankingItem): RowAction =>
      item.key === "a" ? { kind: "button", onActivate, ariaLabel: `查看${item.label}` } : { kind: "none" };
    render(
      <CompositionRanking
        items={items}
        other={null}
        otherExpanded={false}
        onToggleOther={() => {}}
        actionFor={actionFor}
        currency={CNY}
        percentageContext="total"
      />,
    );
    const btn = screen.getByRole("button", { name: "查看现金" });
    fireEvent.click(btn);
    expect(onActivate).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(btn, { key: "Enter" });
    fireEvent.keyDown(btn, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(3);
    // 不可点击行渲染为非交互元素
    expect(screen.queryByRole("button", { name: "查看投资" })).toBeNull();
    expect(screen.getByText("投资").tagName).not.toBe("BUTTON");
  });

  it("renders link rows as real anchors with href", () => {
    const actionFor = (): RowAction => ({
      kind: "link",
      href: "/transactions?report_side=expense&report_category=%E9%A4%90%E9%A5%AE",
      ariaLabel: "查看餐饮流水",
    });
    render(
      <CompositionRanking
        items={[{ key: "a", label: "餐饮", amountText: "300", percentage: 100, colorIndex: 0 }]}
        other={null}
        otherExpanded={false}
        onToggleOther={() => {}}
        actionFor={actionFor}
        currency={CNY}
        percentageContext="filtered"
      />,
    );
    const link = screen.getByRole("link", { name: "查看餐饮流水" });
    expect(link.getAttribute("href")).toContain("report_side=expense");
    // 主行不嵌套其他交互元素
    expect(link.querySelector("button, a[href]")).toBeNull();
  });

  it("shows percentages with 1 decimal; hidden entirely in amount-only mode", () => {
    const none = (): RowAction => ({ kind: "none" });
    const { unmount } = render(
      <CompositionRanking
        items={items}
        other={null}
        otherExpanded={false}
        onToggleOther={() => {}}
        actionFor={none}
        currency={CNY}
        percentageContext="total"
      />,
    );
    expect(screen.getByText("65.2%")).toBeTruthy();
    unmount();

    render(
      <CompositionRanking
        items={[{ key: "a", label: "现金", amountText: "1500", negative: false }]}
        other={null}
        otherExpanded={false}
        onToggleOther={() => {}}
        actionFor={none}
        currency={CNY}
        percentageContext="total"
        showPercentages={false}
      />,
    );
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByText("现金")).toBeTruthy();
  });

  it("toggles Other expansion with aria-expanded and keeps child actions", () => {
    const onToggleOther = vi.fn();
    const childAction = vi.fn();
    const actionFor = (item: RankingItem): RowAction =>
      item.amountText === "50"
        ? { kind: "button", onActivate: childAction, ariaLabel: `查看${item.label}` }
        : { kind: "none" };
    render(
      <CompositionRanking
        items={items.slice(0, 1)}
        other={{
          amountText: "120",
          percentage: 20,
          children: [
            { key: "c1", label: "副业1", amountText: "70", percentage: 12, colorIndex: 7 },
            { key: "c2", label: "副业2", amountText: "50", percentage: 8, colorIndex: 8 },
          ],
        }}
        otherExpanded={false}
        onToggleOther={onToggleOther}
        actionFor={actionFor}
        currency={CNY}
        percentageContext="total"
      />,
    );
    const otherBtn = screen.getByRole("button", { name: /其他/ });
    expect(otherBtn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("副业1")).toBeNull();
    fireEvent.click(otherBtn);
    expect(onToggleOther).toHaveBeenCalledTimes(1);
  });

  it("renders Other children when expanded", () => {
    render(
      <CompositionRanking
        items={items.slice(0, 1)}
        other={{
          amountText: "120",
          percentage: 20,
          children: [
            { key: "c1", label: "副业1", amountText: "70", percentage: 12, colorIndex: 7 },
          ],
        }}
        otherExpanded
        onToggleOther={() => {}}
        actionFor={() => ({ kind: "none" })}
        currency={CNY}
        percentageContext="total"
      />,
    );
    expect(screen.getByText("副业1")).toBeTruthy();
    const otherBtn = screen.getByRole("button", { name: /其他/ });
    expect(otherBtn.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders zero rows without percentage or bar", () => {
    render(
      <CompositionRanking
        items={[]}
        other={null}
        zeroItems={[{ key: "z", label: "空账户", amountText: "0" }]}
        otherExpanded={false}
        onToggleOther={() => {}}
        actionFor={() => ({ kind: "none" })}
        currency={CNY}
        percentageContext="total"
      />,
    );
    const row = screen.getByText("空账户").closest("li");
    expect(row).toBeTruthy();
    expect(row!.querySelector(".comp-rank-pct")).toBeNull();
    expect(row!.querySelector(".comp-rank-bar")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CompositionFilterControl
// ---------------------------------------------------------------------------

describe("CompositionFilterControl", () => {
  const tree: FilterOption[] = [
    {
      key: "g1",
      label: "现金",
      children: [
        { key: "a1", label: "银行甲" },
        { key: "a2", label: "Wallet A" },
      ],
    },
    { key: "a3", label: "Broker A", disabled: true },
  ];

  function openPanel(selection: SelectionState = { kind: "all" }) {
    const onChange = vi.fn();
    const onReset = vi.fn();
    const utils = render(
      <CompositionFilterControl
        ariaLabel="筛选资产账户"
        options={tree}
        selection={selection}
        onChange={onChange}
        onReset={onReset}
      />,
    );
    const triggerName =
      selection.kind === "include" && selection.keys.size > 0
        ? `筛选 (${selection.keys.size})`
        : "筛选";
    fireEvent.click(screen.getByRole("button", { name: triggerName }));
    return { ...utils, onChange, onReset };
  }

  it("trigger shows 筛选 when all, 筛选 (N) when include; opens dialog on click", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    const { rerender } = render(
      <CompositionFilterControl
        ariaLabel="筛选" options={tree} selection={{ kind: "all" }} onChange={onChange} onReset={onReset}
      />,
    );
    expect(screen.getByRole("button", { name: "筛选" })).toBeTruthy();

    rerender(
      <CompositionFilterControl
        ariaLabel="筛选" options={tree}
        selection={{ kind: "include", keys: new Set(["a1"]) }}
        onChange={onChange} onReset={onReset}
      />,
    );
    expect(screen.getByRole("button", { name: "筛选 (1)" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "筛选 (1)" }));
    expect(screen.getByRole("dialog", { name: "筛选" })).toBeTruthy();
  });

  it("toggling a leaf from all produces include with remaining keys; group batch selects children", () => {
    const { onChange } = openPanel();
    const walletLeaf = screen.getByRole("checkbox", { name: "Wallet A" }) as HTMLInputElement;
    expect(walletLeaf.checked).toBe(true); // all = 全选
    fireEvent.click(walletLeaf);
    const first = onChange.mock.calls[0][0] as SelectionState;
    expect(first.kind).toBe("include");
    if (first.kind !== "include") return;
    expect(first.keys.has("a1")).toBe(true);
    expect(first.keys.has("a2")).toBe(false);
    expect(first.keys.has("a3")).toBe(true); // 禁用项保留在全选集中

    // group checkbox 批量：全选 → 取消全部子项
    onChange.mockClear();
    const group = screen.getByRole("checkbox", { name: "现金" }) as HTMLInputElement;
    fireEvent.click(group);
    const second = onChange.mock.calls[0][0] as SelectionState;
    expect(second.kind).toBe("include");
    if (second.kind !== "include") return;
    expect(second.keys.has("a1")).toBe(false);
    expect(second.keys.has("a2")).toBe(false);
    expect(second.keys.has("a3")).toBe(true);
  });

  it("shows indeterminate on group checkbox for partial selection", () => {
    openPanel({ kind: "include", keys: new Set(["a1"]) });
    const group = screen.getByRole("checkbox", { name: "现金" }) as HTMLInputElement;
    expect(group.indeterminate).toBe(true);
    const leaf = screen.getByRole("checkbox", { name: "银行甲" }) as HTMLInputElement;
    expect(leaf.checked).toBe(true);
    const walletLeaf = screen.getByRole("checkbox", { name: "Wallet A" }) as HTMLInputElement;
    expect(walletLeaf.checked).toBe(false);
  });

  it("filters options by search text", () => {
    openPanel();
    fireEvent.change(screen.getByPlaceholderText("搜索"), { target: { value: "wallet" } });
    expect(screen.getByRole("checkbox", { name: "Wallet A" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "银行甲" })).toBeNull();
  });

  it("reset button calls onReset; empty options show guidance without crashing", () => {
    const { onReset } = openPanel();
    fireEvent.click(screen.getByRole("button", { name: "重置" }));
    expect(onReset).toHaveBeenCalledTimes(1);
    cleanup();

    render(
      <CompositionFilterControl
        ariaLabel="筛选" options={[]} selection={{ kind: "all" }} onChange={() => {}} onReset={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    expect(screen.getByText("当前范围没有可筛选项目")).toBeTruthy();
  });

  it("closes on Escape and restores focus to the trigger", () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <CompositionFilterControl
        ariaLabel="筛选" options={tree} selection={{ kind: "all" }} onChange={onChange} onReset={onReset}
      />,
    );
    const trigger = screen.getByRole("button", { name: "筛选" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on outside click", () => {
    openPanel();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("traps Tab focus inside the panel", () => {
    openPanel();
    const panel = screen.getByRole("dialog");
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>("button, input:not([disabled])"),
    );
    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(panel, { key: "Tab" });
    // 焦点循环回到面板内第一个可聚焦元素
    expect(panel.contains(document.activeElement)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CompositionOffsetBlock
// ---------------------------------------------------------------------------

describe("CompositionOffsetBlock", () => {
  it("renders nothing without offsets", () => {
    const { container } = render(
      <CompositionOffsetBlock
        title="冲减项（退款）"
        offsets={[]}
        grossText="450" offsetTotalText="50" netText="400"
        grossLabel="支出合计" netLabel="净支出" currency={CNY}
      />,
    );
    expect(container.querySelector(".comp-offset")).toBeNull();
  });

  it("renders negative signed amounts and the reconciliation formula", () => {
    render(
      <CompositionOffsetBlock
        title="冲减项（负余额）"
        offsets={[{
          key: "a3",
          label: "保证金",
          signedAmount: { units: -20000n, scale: 2 },
          signedAmountText: "-200",
        }]}
        grossText="1500" offsetTotalText="200" netText="1300"
        grossLabel="正向合计" netLabel="净额" currency={CNY}
      />,
    );
    expect(screen.getByText("冲减项（负余额）")).toBeTruthy();
    expect(screen.getByText("保证金")).toBeTruthy();
    const row = screen.getByText("保证金").closest("li")!;
    expect(row.textContent).toContain("−200.00"); // SignedAmount 保留负号（U+2212）
    const formula = screen.getByText("正向合计").closest(".comp-offset-formula")!;
    expect(formula.textContent).toContain("1,500");
    expect(formula.textContent).toContain("200");
    expect(formula.textContent).toContain("1,300");
    expect(formula.textContent).toContain("−"); // gross − abs(offsets) = net
  });
});

// ---------------------------------------------------------------------------
// CompositionFxBlocked
// ---------------------------------------------------------------------------

describe("CompositionFxBlocked", () => {
  it("renders title with subject, native amounts, missing currencies; no percentage or donut", () => {
    const { container } = render(
      <CompositionFxBlocked
        subjectLabel="资产"
        rows={[{
          key: "h1", groupLabel: "现金", label: "Bank B", currency: "HKD",
          nativeAmount: "100", baseAmount: null,
        }]}
        missingCurrencies={["HKD"]}
        baseCurrency={CNY}
      />,
    );
    expect(screen.getByText("汇率不完整，暂无法计算完整资产构成占比")).toBeTruthy();
    expect(screen.getByText("Bank B")).toBeTruthy();
    expect(screen.getByText("缺汇率")).toBeTruthy();
    expect(screen.getAllByText("HKD").length).toBeGreaterThan(0); // 币种列 + 缺失披露
    expect(container.textContent).not.toContain("%");
    expect(container.querySelector("canvas, .comp-donut")).toBeNull();
  });

  it("uses controller-provided wording for flow fail-closed base column and fallback note", () => {
    render(
      <CompositionFxBlocked
        subjectLabel="支出"
        rows={[{ key: "r1", label: "餐饮", currency: "EUR", nativeAmount: "10", baseAmount: null }]}
        missingCurrencies={[]}
        baseCurrency={CNY}
        baseMissingText="报表汇率不完整，未提供折算"
        fallbackNote="后端已按币种保留原币金额，CNY 合计暂不可用"
      />,
    );
    expect(screen.getByText("报表汇率不完整，未提供折算")).toBeTruthy();
    expect(screen.getByText("后端已按币种保留原币金额，CNY 合计暂不可用")).toBeTruthy();
  });

  it("shows existing base value when present", () => {
    render(
      <CompositionFxBlocked
        subjectLabel="资产"
        rows={[{ key: "h1", groupLabel: "现金", label: "银行甲", currency: "CNY", nativeAmount: "1000", baseAmount: "1000" }]}
        missingCurrencies={["HKD"]}
        baseCurrency={CNY}
      />,
    );
    expect(screen.getAllByText("1,000.00").length).toBeGreaterThan(0); // 原币列与折算列
  });
});

describe("CompositionFilterControl — 清除筛选可达性（P3-2）", () => {
  const clearTree: FilterOption[] = [
    {
      key: "g1",
      label: "现金",
      children: [
        { key: "a1", label: "银行甲" },
        { key: "a2", label: "Wallet A" },
      ],
    },
  ];
  it("清除筛选是与 trigger 并列的真实按钮，不嵌套交互元素", () => {
    const onReset = vi.fn();
    render(
      <CompositionFilterControl
        ariaLabel="筛选" options={clearTree}
        selection={{ kind: "include", keys: new Set(["a1"]) }}
        onChange={() => {}} onReset={onReset}
      />,
    );
    const trigger = screen.getByRole("button", { name: "筛选 (1)" });
    // button 内容模型禁止交互子元素（axe nested-interactive）
    expect(trigger.querySelector("button, [role='button']")).toBeNull();
    // 清除控件是兄弟真实按钮，键盘/读屏可达
    const clear = screen.getByRole("button", { name: "清除筛选" });
    expect(trigger.contains(clear)).toBe(false);
    fireEvent.click(clear);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("无激活筛选时不显示清除按钮", () => {
    render(
      <CompositionFilterControl
        ariaLabel="筛选" options={clearTree} selection={{ kind: "all" }}
        onChange={() => {}} onReset={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "筛选" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "清除筛选" })).toBeNull();
  });
});
