import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResponsiveDataView } from "../components/ResponsiveDataView";

describe("ResponsiveDataView", () => {
  it("renders loading skeleton when isLoading is true", () => {
    render(
      <ResponsiveDataView
        isLoading={true}
        loadingSkeleton={<div data-testid="skeleton">Loading...</div>}
        desktop={<div>Desktop</div>}
        mobile={<div>Mobile</div>}
      />
    );
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
    expect(screen.queryByText("Desktop")).not.toBeInTheDocument();
  });

  it("renders empty state when isEmpty is true", () => {
    render(
      <ResponsiveDataView
        isEmpty={true}
        emptyTitle="暂无明细"
        desktop={<div>Desktop</div>}
        mobile={<div>Mobile</div>}
      />
    );
    expect(screen.getByText("暂无明细")).toBeInTheDocument();
  });

  it("renders both desktop and mobile containers when loaded with data", () => {
    render(
      <ResponsiveDataView
        desktop={<div data-testid="desktop-content">Table</div>}
        mobile={<div data-testid="mobile-content">Cards</div>}
      />
    );
    expect(screen.getByTestId("desktop-content")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-content")).toBeInTheDocument();
  });
});
