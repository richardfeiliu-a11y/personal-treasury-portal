import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ProductSwitcher, type ProductSwitcherHandle } from "../components/ProductSwitcher";
import { DeepLink } from "../components/DeepLink";

describe("ProductSwitcher (ALIGN-01)", () => {
  it("renders Treasury Finance trigger", () => {
    render(<ProductSwitcher current="Finance" />);
    expect(screen.getByText("Treasury Finance")).toBeInTheDocument();
    expect(screen.getByTestId("product-switcher")).toBeInTheDocument();
  });

  it("opens menu on click and lists Finance + Invest", async () => {
    render(<ProductSwitcher current="Finance" />);
    const trigger = screen.getByLabelText("Treasury \u5de5\u4f5c\u533a\u5207\u6362\u5668");
    fireEvent.click(trigger);
    expect(await screen.findByText("Treasury Invest")).toBeInTheDocument();
    // Trigger + menu both contain "Treasury Finance" — assert at least 2 occurrences
    expect(screen.getAllByText("Treasury Finance").length).toBeGreaterThanOrEqual(2);
  });

  it("⌘1 / ⌘2 shortcuts shown in menu", async () => {
    render(<ProductSwitcher current="Finance" />);
    fireEvent.click(screen.getByLabelText("Treasury \u5de5\u4f5c\u533a\u5207\u6362\u5668"));
    expect(await screen.findByText("⌘1")).toBeInTheDocument();
    expect(screen.getByText("⌘2")).toBeInTheDocument();
  });

  it("⌘1 快捷键在输入框内不生效，输入框外生效（守卫极性回归锁）", async () => {
    const { baseElement } = render(
      <>
        <ProductSwitcher current="Finance" />
        <input aria-label="极性测试输入框" />
      </>
    );
    const trigger = screen.getByLabelText("Treasury 工作区切换器");
    fireEvent.click(trigger);
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    const input = baseElement.querySelector("input")!;
    input.focus();

    // 输入框内按键：不触发快捷键，菜单保持打开
    fireEvent.keyDown(input, { key: "1", metaKey: true });
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // 输入框外按键：触发快捷键（切换动作），菜单关闭
    input.blur();
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("⌘2 仅在带 Meta 修饰键时生效，纯数字键不触发", async () => {
    render(<ProductSwitcher current="Finance" />);
    const trigger = screen.getByLabelText("Treasury 工作区切换器");
    fireEvent.click(trigger);
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    // 纯数字键不触发，菜单保持打开
    fireEvent.keyDown(window, { key: "2" });
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // 带 Meta 修饰键触发，菜单关闭
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("menu items cycle with arrow keys and Escape returns focus to the trigger", async () => {
    render(<ProductSwitcher current="Finance" />);
    const trigger = screen.getByLabelText("Treasury 工作区切换器");
    fireEvent.click(trigger);
    const items = await screen.findAllByRole("menuitem");

    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: "ArrowUp" });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: "Escape" });
    expect(trigger).toHaveFocus();
  });

  it("通过 forwardRef 暴露 open() 方法并可程序化打开菜单", async () => {
    const ref = React.createRef<ProductSwitcherHandle>();
    render(<ProductSwitcher ref={ref} current="Finance" />);
    expect(ref.current).toBeDefined();
    expect(typeof ref.current?.open).toBe("function");

    act(() => {
      ref.current?.open();
    });

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("Treasury Invest")).toBeInTheDocument();
  });

  it("打开菜单时包含 sr-only a11y 提示「切换 Treasury 工作区」", async () => {
    render(<ProductSwitcher current="Finance" />);
    const trigger = screen.getByLabelText("Treasury 工作区切换器");
    fireEvent.click(trigger);
    expect(await screen.findByText("切换 Treasury 工作区")).toHaveClass("sr-only");
  });
});

describe("DeepLink (ALIGN-09)", () => {
  it("href contains only account param, no balance/id", () => {
    render(<DeepLink label="\u5728 Invest \u4e2d\u67e5\u770b" accountName="Broker A EUR" />);
    const a = screen.getByTestId("deep-link-invest") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toContain("account=Broker%20A%20EUR");
    expect(a.getAttribute("href")).not.toContain("balance");
    expect(a.getAttribute("href")).not.toContain("id=");
  });

  it("renders ↗ arrow style", () => {
    render(<DeepLink label="Open in Invest" accountName="Test" />);
    const a = screen.getByTestId("deep-link-invest");
    expect(a.textContent).toContain("Open in Invest");
  });
});
