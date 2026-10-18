import { describe, expect, it } from "vitest";
import { pctChange, trendTone } from "../utils/trends";

describe("trend presentation", () => {
  it("calculates percentage change with an absolute previous denominator", () => {
    expect(pctChange("120", "100")).toBe("+20%");
    expect(pctChange("80", "100")).toBe("-20%");
    expect(pctChange("80", "0")).toBeNull();
  });

  it("treats lower expense as favorable", () => {
    expect(trendTone("-52.61%", "lower-is-better")).toBe("positive");
    expect(trendTone("12%", "lower-is-better")).toBe("negative");
  });

  it("treats higher income and net result as favorable", () => {
    expect(trendTone("18%", "higher-is-better")).toBe("positive");
    expect(trendTone("-18%", "higher-is-better")).toBe("negative");
    expect(trendTone(null, "higher-is-better")).toBe("neutral");
  });
});
