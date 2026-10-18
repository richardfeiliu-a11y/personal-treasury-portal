import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GoalSetter } from "../components/GoalSetter";
import { MaskProvider } from "../components/MaskContext";

describe("GoalSetter", () => {
  it("shows a set-goal button when no goal is set", () => {
    render(<GoalSetter goal={null} currency="CNY" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "设目标" })).toBeInTheDocument();
  });

  it("shows the formatted goal when set", () => {
    render(<GoalSetter goal={100000} currency="CNY" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /目标/ })).toHaveTextContent("目标 100,000.00 CNY");
  });

  it("saves a parsed goal on submit", () => {
    const onChange = vi.fn();
    render(<GoalSetter goal={null} currency="CNY" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "设目标" }));
    fireEvent.change(screen.getByRole("textbox", { name: "净资产目标金额" }), {
      target: { value: "100,000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onChange).toHaveBeenCalledWith(100000);
  });

  it("prefills the draft with the current goal", () => {
    render(<GoalSetter goal={100000} currency="CNY" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /目标/ }));
    expect(screen.getByRole("textbox", { name: "净资产目标金额" })).toHaveValue("100000");
  });

  it("discards the draft on cancel", () => {
    render(<GoalSetter goal={100000} currency="CNY" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /目标/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "净资产目标金额" }), { target: { value: "99999" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: /目标/ }));
    expect(screen.getByRole("textbox", { name: "净资产目标金额" })).toHaveValue("100000");
  });

  it("clears the goal", () => {
    const onChange = vi.fn();
    render(<GoalSetter goal={100000} currency="CNY" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /目标/ }));
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("masks the goal text when masked", () => {
    window.localStorage.setItem("report-web.mask", "1");
    render(
      <MaskProvider>
        <GoalSetter goal={100000} currency="CNY" onChange={() => {}} />
      </MaskProvider>,
    );
    expect(screen.getByRole("button", { name: /目标/ })).toHaveTextContent("目标 •••• CNY");
  });
});
