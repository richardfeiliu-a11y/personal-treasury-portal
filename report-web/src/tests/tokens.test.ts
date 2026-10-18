import { describe, it, expect } from "vitest";
import tokensRaw from "../shadcn.css?raw";

// shadcn.css holds several :root blocks (shadcn theme vars, light tokens, dark).
// Collect all blocks; the light design-token block is the one that defines --green-50.
const rootBlocks = [...tokensRaw.matchAll(/:root\s*\{([^}]+)\}/g)].map((m) => m[1]);

function getTokenValue(name: string): string | undefined {
  const re = new RegExp(`--${name}:\\s*([^;]+);`);
  for (const block of rootBlocks) {
    const m = block.match(re);
    if (m) return m[1].trim();
  }
  return undefined;
}

function expectToken(name: string, expected: string) {
  const val = getTokenValue(name);
  expect(val, `--${name}`).toBeDefined();
  expect(val!.toLowerCase()).toBe(expected.toLowerCase());
}

describe("Design tokens — ALIGN-05 semantic 500-level", () => {
  it("has --success-500 #10B981", () => {
    expectToken("success-500", "#10b981");
  });

  it("has --danger-500 #F43F5E", () => {
    expectToken("danger-500", "#f43f5e");
  });

  it("has --warning-500 #D97706", () => {
    expectToken("warning-500", "#d97706");
  });
});

// ALIGN-07 原断言旧轨 --neutral-50 / --neutral-500。2026-10-18 旧轨物理删除后，
// 这两个值由语义角色 token 承载，断言改为指向新名 —— 校验的仍是同一个渲染色，
// 因此「值被改动」依然会失败，但不会强迫旧轨复活。
describe("Design tokens — ALIGN-07 语义角色（原 neutral-50 / neutral-500）", () => {
  it("--surface-hover 沿用原 neutral-50 的亮色值 #F9FAFB", () => {
    expectToken("surface-hover", "#f9fafb");
  });

  it("--text-faint 沿用原 neutral-500 的亮色值 #6B7280", () => {
    expectToken("text-faint", "#6b7280");
  });
});

describe("Design tokens — ALIGN-08 overlay & shadow", () => {
  it("has --overlay-obsidian rgba(11, 15, 25, 0.6)", () => {
    expectToken("overlay-obsidian", "rgba(11, 15, 25, 0.6)");
  });

  it("has --shadow-family-overlay", () => {
    const val = getTokenValue("shadow-family-overlay");
    expect(val).toBeDefined();
    expect(val).toContain("0 20px 25px");
  });
});

describe("Design tokens — 600/700 compatibility preserved", () => {
  it("still has --success-600", () => {
    expect(getTokenValue("success-600")).toBeDefined();
  });

  it("still has --success-700", () => {
    expect(getTokenValue("success-700")).toBeDefined();
  });

  it("still has --danger-600", () => {
    expect(getTokenValue("danger-600")).toBeDefined();
  });

  it("still has --danger-700", () => {
    expect(getTokenValue("danger-700")).toBeDefined();
  });

  it("still has --warning-600", () => {
    expect(getTokenValue("warning-600")).toBeDefined();
  });

  it("still has --warning-800", () => {
    expect(getTokenValue("warning-800")).toBeDefined();
  });
});
