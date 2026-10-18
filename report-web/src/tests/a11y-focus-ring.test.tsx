import { describe, it, expect } from "vitest";
import tokensRaw from "../shadcn.css?raw";

function extractBlocks(raw: string, selector: string): string[] {
  const re = new RegExp(`${selector}\\s*\\{([^}]+)\\}`, "sg");
  return [...raw.matchAll(re)].map((m) => m[1].trim());
}

function getToken(blocks: string[], name: string): string | undefined {
  const re = new RegExp(`--${name}:\\s*([^;]+);`);
  for (const block of blocks) {
    const m = block.match(re);
    if (m) return m[1].trim();
  }
  return undefined;
}

describe("A11y Focus Ring Token (WP3 / 21-audit M3)", () => {
  it("亮色主题下 --focus-ring 透明度为 .5", () => {
    const val = getToken(extractBlocks(tokensRaw, ":root"), "focus-ring");
    expect(val).toBe("0 0 0 3px rgba(40, 160, 111, 0.5)");
  });

  it("暗色主题下 [data-theme='dark'] 的 --focus-ring 透明度为 .35", () => {
    const val = getToken(extractBlocks(tokensRaw, '\\[data-theme="dark"\\]'), "focus-ring");
    expect(val).toBe("0 0 0 3px rgba(40, 160, 111, 0.35)");
  });

  it("Focus ring 采用统一家族绿色 rgba(40, 160, 111, ...)", () => {
    const val = getToken(extractBlocks(tokensRaw, ":root"), "focus-ring");
    expect(val).toContain("rgba(40, 160, 111,");
  });
});
