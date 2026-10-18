import { beforeEach, describe, expect, it } from "vitest";
import { getNetWorthGoal, setNetWorthGoal } from "../utils/goal";

describe("net worth goal storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns null when no goal is stored", () => {
    expect(getNetWorthGoal()).toBeNull();
  });

  it("round-trips a positive number", () => {
    setNetWorthGoal(100000);
    expect(getNetWorthGoal()).toBe(100000);
    expect(window.localStorage.getItem("report-web.net-worth-goal")).toBe("100000");
  });

  it("clears the goal when set to null", () => {
    setNetWorthGoal(100000);
    setNetWorthGoal(null);
    expect(getNetWorthGoal()).toBeNull();
  });

  it("returns null for invalid stored values", () => {
    window.localStorage.setItem("report-web.net-worth-goal", "abc");
    expect(getNetWorthGoal()).toBeNull();
    window.localStorage.setItem("report-web.net-worth-goal", "-5");
    expect(getNetWorthGoal()).toBeNull();
  });
});
