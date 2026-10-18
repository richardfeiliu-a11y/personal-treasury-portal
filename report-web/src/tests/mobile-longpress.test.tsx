import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Layout } from "../components/Layout";
import { MaskProvider } from "../components/MaskContext";

describe("Mobile Long-press on ProductSwitcher (spec v1.2 §5-bis.7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("767px") ? true : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderMobileLayout() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <MemoryRouter>
        <MaskProvider>
          <QueryClientProvider client={qc}>
            <Layout />
          </QueryClientProvider>
        </MaskProvider>
      </MemoryRouter>
    );
  }

  it("移动端长按 ProductSwitcher ≥ 600ms 触发菜单打开", () => {
    renderMobileLayout();
    const trigger = screen.getByLabelText("Treasury 工作区切换器");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    act(() => {
      trigger.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          touches: [{ clientX: 50, clientY: 50 } as unknown as Touch],
        })
      );
    });

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("Treasury Invest")).toBeInTheDocument();
  });

  it("长按 < 600ms 时释放触摸，不触发菜单打开", () => {
    renderMobileLayout();
    const trigger = screen.getByLabelText("Treasury 工作区切换器");

    act(() => {
      trigger.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          touches: [{ clientX: 50, clientY: 50 } as unknown as Touch],
        })
      );
    });

    act(() => {
      vi.advanceTimersByTime(300);
      trigger.dispatchEvent(new TouchEvent("touchend", { bubbles: true }));
    });

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("长按过程中滑动超过 10px 视为滚动，取消长按", () => {
    renderMobileLayout();
    const trigger = screen.getByLabelText("Treasury 工作区切换器");

    act(() => {
      trigger.dispatchEvent(
        new TouchEvent("touchstart", {
          bubbles: true,
          touches: [{ clientX: 50, clientY: 50 } as unknown as Touch],
        })
      );
    });

    act(() => {
      vi.advanceTimersByTime(200);
      trigger.dispatchEvent(
        new TouchEvent("touchmove", {
          bubbles: true,
          touches: [{ clientX: 50, clientY: 75 } as unknown as Touch], // 移动 25px > 10px
        })
      );
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
