import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../components/ErrorBoundary";

function Bomb(): never {
  throw new Error("boom: 渲染阶段抛错");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("渲染子组件正常时不显示错误 UI", () => {
    render(
      <ErrorBoundary>
        <div>正常内容</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("正常内容")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("子组件渲染抛错时展示错误提示与刷新按钮，并输出 console.error", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/页面加载失败/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "刷新页面" }),
    ).toBeInTheDocument();
    // 关键可观测性要求：原始错误必须落到 console.error，便于日志采集排查
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ErrorBoundary]"),
      expect.any(Error),
      expect.anything(),
    );
  });
});
