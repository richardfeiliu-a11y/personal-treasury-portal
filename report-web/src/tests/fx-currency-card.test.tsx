import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FxCurrencyCard } from "../components/FxCurrencyCard";

const ROW = {
  currency: "EUR",
  start_balance: "100.00",
  end_balance: "150.00",
  start_rate: 7.5,
  end_rate: 7.6,
  savings_contribution_cny: "380.00",
  fx_contribution_cny: "10.00",
  net_change_cny: "390.00",
};

describe("FxCurrencyCard", () => {
  it("默认展示余额、两类贡献和净变动", () => {
    render(<FxCurrencyCard row={ROW} baseCurrency="CNY" />);

    expect(screen.getByRole("heading", { name: "EUR" })).toBeInTheDocument();
    expect(screen.getByText("期初余额")).toBeInTheDocument();
    expect(screen.getByText("期末余额")).toBeInTheDocument();
    expect(screen.getByText("非汇率余额变动贡献")).toBeInTheDocument();
    expect(screen.getByText("汇率贡献")).toBeInTheDocument();
    expect(screen.getByText("净变动")).toBeInTheDocument();
    const amountOf = (label: string) =>
      screen.getByText(label).parentElement!.textContent;
    expect(amountOf("380.00")).toBe("380.00CNYCNY");
    expect(amountOf("10.00")).toBe("10.00CNYCNY");
    expect(amountOf("390.00")).toBe("390.00CNYCNY");
  });

  it("将期初和期末汇率收进默认关闭的 details", () => {
    render(<FxCurrencyCard row={ROW} baseCurrency="CNY" />);

    const summary = screen.getByText("汇率详情");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(within(details!).getByText("期初汇率")).toBeInTheDocument();
    expect(within(details!).getByText("期末汇率")).toBeInTheDocument();
    expect(within(details!).getByText("7.50")).toBeInTheDocument();
    expect(within(details!).getByText("7.60")).toBeInTheDocument();
  });
});
