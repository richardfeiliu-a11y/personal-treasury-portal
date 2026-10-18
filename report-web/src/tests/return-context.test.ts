import { describe, it, expect, beforeEach } from "vitest";
import { saveReturnContext, restoreReturnContext, clearReturnContext } from "../utils/returnContext";

describe("returnContext (session memory)", () => {
  beforeEach(() => sessionStorage.clear());

  it("saves and restores path + account", () => {
    saveReturnContext({ path: "/balance-sheet?as_of=2026-08-18", accountName: "Broker A" });
    const ctx = restoreReturnContext();
    expect(ctx?.path).toBe("/balance-sheet?as_of=2026-08-18");
    expect(ctx?.accountName).toBe("Broker A");
  });

  it("clear removes context", () => {
    saveReturnContext({ path: "/", accountName: "X" });
    clearReturnContext();
    expect(restoreReturnContext()).toBeNull();
  });

  it("returns null when empty", () => {
    expect(restoreReturnContext()).toBeNull();
  });
});
