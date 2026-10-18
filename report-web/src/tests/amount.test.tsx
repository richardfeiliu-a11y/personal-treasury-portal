import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Amount, SignedAmount } from "../components/Amount";
import { MaskProvider } from "../components/MaskContext";

function renderWithMask(ui: React.ReactNode) {
  return render(<MaskProvider>{ui}</MaskProvider>);
}

describe("Amount visual structure", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("keeps number and currency in separate inline elements", () => {
    const { container } = renderWithMask(<Amount value="1234.5" currency="EUR" />);
    expect(container.querySelector(".amount-number")).toHaveTextContent("1,234.50");
    expect(container.querySelector(".amount-currency")).toHaveTextContent("EUR");
    expect(container.querySelector(".amount")).toHaveTextContent("1,234.50");
  });

  it("renders positive values with the currency", () => {
    const { container } = renderWithMask(<Amount value="1234.5" currency="EUR" />);
    expect(container.querySelector(".amount-number")).toHaveTextContent("1,234.50");
    expect(container.querySelector(".amount-currency")).toHaveTextContent("EUR");
  });

  it("renders negative values with the minus sign", () => {
    const { container } = renderWithMask(<Amount value="-12.3" currency="CNY" />);
    expect(container.querySelector(".amount-number")).toHaveTextContent("-12.30");
  });

  it("renders zero as an actual zero, not as missing", () => {
    const { container } = renderWithMask(<Amount value="0" currency="USD" />);
    expect(container.querySelector(".amount-number")).toHaveTextContent("0.00");
    expect(container.querySelector(".amount")).not.toHaveClass("amount-missing");
  });

  it("treats null as missing FX and never renders zero", () => {
    const { container } = renderWithMask(<Amount value={null} currency="EUR" />);
    expect(container.querySelector(".amount")).toHaveClass("amount-missing");
    expect(container.querySelector(".amount")).toHaveTextContent("汇率缺失");
    expect(container.querySelector(".amount-number")).not.toBeInTheDocument();
  });

  it("treats undefined as missing FX and never renders zero", () => {
    const { container } = renderWithMask(<Amount value={undefined} currency="EUR" />);
    expect(container.querySelector(".amount")).toHaveClass("amount-missing");
    expect(container.querySelector(".amount")).toHaveTextContent("汇率缺失");
    expect(container.querySelector(".amount-number")).not.toBeInTheDocument();
  });

  it("keeps currency visible when masked", () => {
    localStorage.setItem("report-web.mask", "1");
    const { container } = renderWithMask(<SignedAmount value="-12.3" currency="CNY" />);
    expect(container.querySelector(".amount-number")).toHaveTextContent("••••");
    expect(container.querySelector(".amount-currency")).toHaveTextContent("CNY");
  });

  it("SignedAmount renders a leading minus for negative values", () => {
    const { container } = renderWithMask(<SignedAmount value="-12.3" currency="CNY" />);
    expect(container.querySelector(".amount-number")).toHaveTextContent("−12.30");
  });

  it("SignedAmount treats null as missing FX and never renders zero", () => {
    const { container } = renderWithMask(<SignedAmount value={null} currency="EUR" />);
    expect(container.querySelector(".amount")).toHaveClass("amount-missing");
    expect(container.querySelector(".amount")).toHaveTextContent("汇率缺失");
    expect(container.querySelector(".amount-number")).not.toBeInTheDocument();
  });
});

describe("Amount — C9/ALIGN-02 suffix-only compliance", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it("never renders ¥ prefix for CNY amounts", () => {
    renderWithMask(<Amount value="123456.78" currency="CNY" />);
    const { container } = renderWithMask(<Amount value="123456.78" currency="CNY" />);
    expect(container.querySelector(".amount-number")?.textContent).toBe("123,456.78");
    expect(container.querySelector(".sr-only")?.textContent).toBe("CNY");
  });

  it("uses suffix form: 123,456.78 CNY", () => {
    const { container } = renderWithMask(<Amount value="123456.78" currency="CNY" />);
    expect(container.querySelector(".amount-number")?.textContent).toBe("123,456.78");
    expect(container.querySelector(".sr-only")?.textContent).toBe("CNY");
  });

  it("SignedAmount also uses suffix form, no ¥", () => {
    const { container } = renderWithMask(<SignedAmount value="-50000" currency="CNY" />);
    expect(container.querySelector(".amount-number")?.textContent).toBe("−50,000.00");
    expect(container.querySelector(".sr-only")?.textContent).toBe("CNY");
  });
});
