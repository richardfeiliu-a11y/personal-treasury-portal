import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "../components/CommandPalette";
import { MaskProvider } from "../components/MaskContext";

// cmdk 在下拉项聚焦/选中时会调用 scrollIntoView，jsdom 不实现，需打桩。
if (typeof window !== "undefined" && !window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

function renderPalette(open: boolean, onClose: () => void) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <CommandPalette open={open} onClose={onClose} toggleTheme={() => {}} isDark={false} />,
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(
    <MaskProvider>
      <RouterProvider router={router} />
    </MaskProvider>,
  );
}

describe("CommandPalette", () => {
  it("渲染关闭态：不输出任何命令面板 DOM", () => {
    renderPalette(false, () => {});

    expect(screen.queryByPlaceholderText("搜索页面或输入指令…")).not.toBeInTheDocument();
    expect(document.querySelector(".cmd-palette-backdrop")).toBeNull();
  });

  it("打开态：渲染导航项与快捷指令，回车选择后触发导航并关闭", () => {
    const onClose = vi.fn();
    renderPalette(true, onClose);

    // 输入框自动聚焦（组件内 50ms 延迟）
    const input = screen.getByPlaceholderText("搜索页面或输入指令…");
    expect(input).toBeInTheDocument();

    // 页面导航项
    expect(screen.getByText("首页")).toBeInTheDocument();
    expect(screen.getByText("资产负债")).toBeInTheDocument();
    // 快捷指令
    expect(screen.getByText("遮蔽金额")).toBeInTheDocument();
    expect(screen.getByText("切换暗色模式")).toBeInTheDocument();

    // 键入过滤：英文 slug 片段（value）仍参与匹配。
    fireEvent.change(input, { target: { value: "balance" } });
    expect(screen.getByText("资产负债")).toBeInTheDocument();
    expect(screen.queryByText("首页")).not.toBeInTheDocument();

    // 中文 keywords 过滤（产品缺陷修复）：输入中文能命中对应页面。
    fireEvent.change(input, { target: { value: "资产" } });
    expect(screen.getByText("资产负债")).toBeInTheDocument();
    expect(screen.queryByText("首页")).not.toBeInTheDocument();
    expect(screen.queryByText("账户")).not.toBeInTheDocument();

    // 选择「首页」→ handleSelect 触发 navigate + onClose
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc 关闭面板", () => {
    const onClose = vi.fn();
    renderPalette(true, onClose);

    fireEvent.keyDown(screen.getByPlaceholderText("搜索页面或输入指令…"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("关闭后恢复打开前的触发控件焦点", () => {
    function FocusHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>打开命令面板</button>
          <CommandPalette open={open} onClose={() => setOpen(false)} toggleTheme={() => {}} isDark={false} />
        </>
      );
    }

    const router = createMemoryRouter(
      [{ path: "/", element: <FocusHarness /> }],
      { initialEntries: ["/"] },
    );
    render(
      <MaskProvider>
        <RouterProvider router={router} />
      </MaskProvider>,
    );

    const trigger = screen.getByRole("button", { name: "打开命令面板" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByPlaceholderText("搜索页面或输入指令…"), { key: "Escape" });
    expect(trigger).toHaveFocus();
  });

  it("中文检索可命中导航项与快捷指令", () => {
    renderPalette(true, () => {});
    const input = screen.getByPlaceholderText("搜索页面或输入指令…");

    // 导航项：中文 keywords 命中
    fireEvent.change(input, { target: { value: "流水" } });
    expect(screen.getByText("明细")).toBeInTheDocument();
    expect(screen.queryByText("首页")).not.toBeInTheDocument();

    // 快捷指令：中文 keywords 命中
    fireEvent.change(input, { target: { value: "暗色" } });
    expect(screen.getByText("切换暗色模式")).toBeInTheDocument();
    expect(screen.queryByText("首页")).not.toBeInTheDocument();
    expect(screen.queryByText("明细")).not.toBeInTheDocument();
  });
});
