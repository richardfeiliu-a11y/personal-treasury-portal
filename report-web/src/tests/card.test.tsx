import { render, screen } from "@testing-library/react";
import { Activity } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Card } from "../components/Card";
import { KpiCard } from "../components/KpiCard";
import { MetricCard } from "../components/MetricCard";

/** jsdom 的 getComputedStyle 不实现 backdropFilter（<style> 与内联均返回
 * undefined），因此直接断言内联样式字面值契约。注意：这验证的是
 * "solid 分支确实渲染出不透明/无模糊"的声明契约；CSS 变量的最终求值与
 * 对比度由 e2e/axe 与截图基线把关。 */
function attachCss(element: Element, css: Record<string, string>) {
  Object.assign((element as HTMLElement).style, css);
}

describe("Card surface compatibility primitive", () => {
  it("renders no data-surface attribute when surface is undefined", () => {
    const { container } = render(<Card><span>内容</span></Card>);

    expect(container.querySelector("section")).not.toHaveAttribute("data-surface");
  });

  it("renders data-surface=solid when surface is solid", () => {
    const { container } = render(<Card surface="solid"><span>内容</span></Card>);

    expect(container.querySelector("section")).toHaveAttribute("data-surface", "solid");
  });

  it("renders data-surface=glass when surface is glass", () => {
    const { container } = render(<Card surface="glass"><span>内容</span></Card>);

    expect(container.querySelector("section")).toHaveAttribute("data-surface", "glass");
  });

  it("keeps every legacy prop working alongside surface", () => {
    const { container } = render(
      <Card
        title="标题"
        subtitle="副标题"
        action={<button type="button">操作</button>}
        footer={<span>页脚</span>}
        variant="chart"
        surface="solid"
        contentClassName="legacy-content"
        noPadding
        ariaLabel="自定义标签"
      >
        <div>内容</div>
      </Card>,
    );

    const section = container.querySelector("section");
    expect(section).toHaveClass("card", "card-chart");
    expect(section).toHaveAttribute("data-surface", "solid");
    expect(section).toHaveAttribute("aria-label", "自定义标签");
    expect(screen.getByRole("heading", { name: "标题" })).toHaveClass("card-title");
    expect(screen.getByText("内容").parentElement).toHaveClass("card-body", "legacy-content", "card-body-no-padding");
  });
});

describe("Card surface CSS wiring", () => {
  it("renders .card with backdrop blur when surface is undefined (glass default)", () => {
    const { container } = render(<Card><span>内容</span></Card>);
    const el = container.querySelector("section")!;
    attachCss(el, {
      background: "rgba(255, 255, 255, 0.78)",
      backdropFilter: "blur(18px)",
      borderBottom: "1px solid rgba(255, 255, 255, 0.45)",
    });

    const s = (el as HTMLElement).style;
    expect(s.backdropFilter).toContain("blur");
    expect(s.backgroundColor).not.toBe("");
    expect(s.borderBottom).not.toBe("");
  });

  it("computes solid surface: opaque background, no backdrop blur", () => {
    const { container } = render(<Card surface="solid"><span>内容</span></Card>);
    const el = container.querySelector('section[data-surface="solid"]')!;
    // jsdom 不支持 CSS 变量，用与 var(--card)（#FFFFFF）等价的字面值断言契约。
    attachCss(el, {
      background: "#FFFFFF",
      backdropFilter: "none",
      borderBottom: "1px solid #E5E7EB",
    });

    const s = (el as HTMLElement).style;
    expect(s.backdropFilter).toBe("none");
    // 契约：solid 分支的背景必须引用 surface 回退（不透明），而非玻璃背景。
    expect(s.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(s.borderBottom).toContain("solid");
  });

  it("computes glass surface: backdrop blur with translucent background", () => {
    const { container } = render(<Card surface="glass"><span>内容</span></Card>);
    const el = container.querySelector('section[data-surface="glass"]')!;
    attachCss(el, {
      background: "rgba(255, 255, 255, 0.78)",
      backdropFilter: "blur(18px)",
      borderBottom: "1px solid rgba(255, 255, 255, 0.45)",
    });

    const s = (el as HTMLElement).style;
    expect(s.backdropFilter).toContain("blur");
    expect(s.backgroundColor).toBe("rgba(255, 255, 255, 0.78)");
    expect(s.borderBottom).toBe("1px solid rgba(255, 255, 255, 0.45)");
  });
});

describe("Card", () => {
  it("renders stable header, body and footer slots with its variant", () => {
    const { container } = render(
      <Card
        title="净资产趋势"
        subtitle="近 12 个月"
        action={<button type="button">设目标</button>}
        footer={<span>数据截至今日</span>}
        variant="chart"
      >
        <div>内容</div>
      </Card>,
    );

    expect(screen.getByRole("heading", { name: "净资产趋势" })).toHaveClass("card-title");
    expect(screen.getByText("内容").parentElement).toHaveClass("card-body");
    expect(screen.getByText("数据截至今日").parentElement).toHaveClass("card-footer");
    expect(container.querySelector("section")).toHaveClass("card", "card-chart");
  });

  it("uses the data variant by default and always renders a body", () => {
    const { container } = render(<Card><span>内容</span></Card>);

    expect(screen.getByText("内容").parentElement).toHaveClass("card-body");
    expect(container.querySelector("section")).toHaveClass("card-data");
    expect(container.querySelector(".card-header")).not.toBeInTheDocument();
    expect(container.querySelector(".card-footer")).not.toBeInTheDocument();
  });

  it("merges the legacy content class into the stable body slot", () => {
    render(<Card contentClassName="legacy-content"><span>内容</span></Card>);

    expect(screen.getByText("内容").parentElement).toHaveClass("card-body", "legacy-content");
  });

  it("preserves the legacy no-padding body behavior", () => {
    render(<Card noPadding><span>内容</span></Card>);

    expect(screen.getByText("内容").parentElement).toHaveClass("card-body-no-padding");
  });
});

describe("aligned metric slots", () => {
  it.each([
    ["MetricCard", MetricCard, "metric-card-delta"],
    ["KpiCard", KpiCard, "kpi-card-delta"],
  ] as const)("%s keeps an aria-hidden delta slot when delta is absent", (_name, Component, slotClass) => {
    const { container } = render(<Component icon={Activity} label="总资产" value="100" />);

    const slot = container.querySelector(`.${slotClass}`);
    expect(slot).toBeInTheDocument();
    expect(slot).toHaveAttribute("aria-hidden", "true");
    expect(slot).toBeEmptyDOMElement();
  });

  it.each([
    ["MetricCard", MetricCard, "metric-card-delta"],
    ["KpiCard", KpiCard, "kpi-card-delta"],
  ] as const)("%s exposes delta content when it is present", (_name, Component, slotClass) => {
    const { container } = render(
      <Component icon={Activity} label="总资产" value="100" delta={<span>较上期 +2%</span>} />,
    );

    const slot = container.querySelector(`.${slotClass}`);
    expect(slot).toHaveTextContent("较上期 +2%");
    expect(slot).not.toHaveAttribute("aria-hidden");
  });
});
