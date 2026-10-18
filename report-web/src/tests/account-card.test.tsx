import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AccountBalanceRow } from "../api/types";
import { AccountCard } from "../components/AccountCard";

const ACCOUNT: AccountBalanceRow = {
  id: "account-1",
  name: "一个足够长、需要在移动端限制为最多两行的账户名称",
  type: "asset",
  currency: "CHF",
  balance: "123.45",
  active: true,
  account_role: null,
  include_net_worth: true,
  group: "bank",
  group_title: "银行",
  balance_base: "987.60",
  fx_rate_date: "2026-08-07",
  fx_source: "ECB",
};

describe("AccountCard", () => {
  it("按冻结两行 KV 模式展示账户名/原币与分组/折算金额", () => {
    const { container } = render(<AccountCard account={ACCOUNT} baseCurrency="CNY" />);

    expect(screen.getByText("银行 · 资产")).toBeInTheDocument();
    const amountText = (label: string) =>
      screen.getByText(label).parentElement!.textContent;
    expect(amountText("123.45")).toBe("123.45CHFCHF");
    expect(screen.getAllByText((_, el) => el?.classList.contains("amount") === true && el.querySelector(".amount-number")?.textContent === "987.60").length).toBeGreaterThan(0);
    expect(container.querySelectorAll(".account-card-row")).toHaveLength(2);

    const card = screen.getByRole("article");
    expect(within(card).getByText(ACCOUNT.name)).toHaveClass("account-name");
    expect(container.querySelectorAll(".account-card-row .amount")).toHaveLength(2);
  });

  it("存在基础币金额时展示折算结果且不显示缺率", () => {
    render(<AccountCard account={ACCOUNT} baseCurrency="CNY" />);

    expect(screen.getAllByText((_, el) => el?.classList.contains("amount") === true && el.querySelector(".amount-number")?.textContent === "987.60").length).toBeGreaterThan(0);
    expect(screen.queryByText(/汇率缺失/)).not.toBeInTheDocument();
  });

  it("缺少汇率时同时说明币种、原因和无法折算的目标币种", () => {
    render(<AccountCard account={{ ...ACCOUNT, balance_base: null }} baseCurrency="CNY" />);

    expect(screen.getByText("CHF 汇率缺失，无法折算 CNY")).toBeInTheDocument();
  });
});
