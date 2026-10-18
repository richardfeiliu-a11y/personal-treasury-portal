import { fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { useAppHeader } from "../components/AppHeader";
import { Layout } from "../components/Layout";
import { MaskProvider } from "../components/MaskContext";

vi.mock("../api/hooks", () => ({
  useBalanceSheet: () => ({ data: undefined }),
  useAnomalies: () => ({ data: undefined }),
}));

function HomeHeaderHarness() {
  useAppHeader({
    title: "首页",
    meta: <span>数据更新 2026-08-09 12:00</span>,
    actions: <button type="button">刷新</button>,
  });
  return <div className="page">首页内容</div>;
}

function HeaderLinkHarness() {
  useAppHeader({
    title: "首页",
    actions: <button type="button">刷新</button>,
  });
  return <Link to="/empty">打开空页面</Link>;
}

function renderHomeRoute() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <MaskProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomeHeaderHarness />} />
          </Route>
        </Routes>
      </MaskProvider>
    </MemoryRouter>,
  );
}

describe("AppHeader", () => {
  it("在唯一全局 Header 中渲染首页标题和页面操作", () => {
    renderHomeRoute();

    expect(document.querySelectorAll("h1")).toHaveLength(1);
    const title = screen.getByRole("heading", { level: 1, name: "首页" });
    expect(title).toBeInTheDocument();
    expect(screen.getByRole("banner")).toContainElement(title);
    expect(screen.getByRole("banner")).toContainElement(
      screen.getByRole("button", { name: "刷新" }),
    );
    expect(document.querySelector(".topbar-empty")).not.toBeInTheDocument();
    expect(document.querySelector(".page-header")).not.toBeInTheDocument();
  });

  it("页面卸载时清空旧标题和操作", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <MaskProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route
                index
                element={
                  <HeaderLinkHarness />
                }
              />
              <Route path="empty" element={<div>空页面</div>} />
            </Route>
          </Routes>
        </MaskProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "打开空页面" }));

    expect(screen.getByText("空页面")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();
  });
});
