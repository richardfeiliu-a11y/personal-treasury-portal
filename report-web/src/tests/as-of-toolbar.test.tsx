import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AsOfToolbar } from "../components/AsOfToolbar";
import { berlinLastMonthEnd } from "../utils/dates";

describe("AsOfToolbar", () => {
  it("renders presets and triggers onAsOfChange when clicked", () => {
    const onAsOfChange = vi.fn();
    render(<AsOfToolbar asOf="2026-08-16" onAsOfChange={onAsOfChange} />);

    const todayBtn = screen.getByRole("button", { name: "今日最新" });
    fireEvent.click(todayBtn);
    expect(onAsOfChange).toHaveBeenCalled();
  });

  it("renders 上月末/去年末 chips and highlights the active as-of", () => {
    const onAsOfChange = vi.fn();
    // 上月末随运行日期变化，必须动态计算，否则月初必挂（2026-09-01 事故）
    // DATA-01：芯片值来自 berlinLastMonthEnd，期望值同口径（宿主时区版在跨月瞬间会失配）
    render(<AsOfToolbar asOf={berlinLastMonthEnd()} onAsOfChange={onAsOfChange} />);

    const group = screen.getByRole("group", { name: "截止时点快捷选项" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上月末" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去年末" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上月末" })).toHaveClass("is-active");
  });

  it("opens the custom date picker when 自定义日期 chip is clicked", () => {
    const onAsOfChange = vi.fn();
    render(<AsOfToolbar asOf="2026-08-16" onAsOfChange={onAsOfChange} />);

    const customBtn = screen.getByRole("button", { name: "自定义日期" });
    fireEvent.click(customBtn);

    expect(screen.getByRole("dialog", { name: "选择日期" })).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: "16" })).toBeInTheDocument();
  });

  it("shows the selected custom date chip and highlights it", () => {
    const onAsOfChange = vi.fn();
    render(<AsOfToolbar asOf="2026-06-15" onAsOfChange={onAsOfChange} />);

    expect(screen.getByRole("button", { name: "自定义日期" })).toHaveClass("is-active");
    expect(screen.getByRole("button", { name: "自定义日期" })).toHaveTextContent("2026-06-15");
    expect(screen.getByRole("button", { name: "今日最新" })).not.toHaveClass("is-active");
    expect(screen.getByRole("button", { name: "上月末" })).not.toHaveClass("is-active");
    expect(screen.getByRole("button", { name: "去年末" })).not.toHaveClass("is-active");
  });

  it("selecting a date in the picker calls onAsOfChange and closes", () => {
    const onAsOfChange = vi.fn();
    render(<AsOfToolbar asOf="2026-08-16" onAsOfChange={onAsOfChange} />);

    fireEvent.click(screen.getByRole("button", { name: "自定义日期" }));
    const day = screen.getByRole("gridcell", { name: "10" });
    fireEvent.click(day);

    expect(onAsOfChange).toHaveBeenCalledWith("2026-08-10");
    expect(screen.queryByRole("dialog", { name: "选择日期" })).not.toBeInTheDocument();
  });

  it("marks the picker modal and traps keyboard focus at its boundaries", async () => {
    const onAsOfChange = vi.fn();
    render(
      <div>
        <AsOfToolbar asOf="2026-08-16" onAsOfChange={onAsOfChange} />
        <button type="button">背景控件</button>
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "自定义日期" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "选择日期" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const focusableDays = screen.getAllByRole("gridcell").filter((day) => !(day as HTMLButtonElement).disabled);
    const last = focusableDays[focusableDays.length - 1];
    const firstFocusable = screen.getByRole("button", { name: "上月" });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(firstFocusable).toHaveFocus();

    fireEvent.keyDown(firstFocusable, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Escape" });
    expect(trigger).toHaveFocus();
  });

  it("clicking outside closes the picker", () => {
    const onAsOfChange = vi.fn();
    render(
      <div>
        <AsOfToolbar asOf="2026-08-16" onAsOfChange={onAsOfChange} />
        <div data-testid="outside">outside</div>
      </div>,
    );

    fireEvent.click(screen.getByRole("button", { name: "自定义日期" }));
    expect(screen.getByRole("dialog", { name: "选择日期" })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("dialog", { name: "选择日期" })).not.toBeInTheDocument();
  });
});
