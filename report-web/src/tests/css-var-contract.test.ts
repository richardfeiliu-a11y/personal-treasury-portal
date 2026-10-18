import { describe, it, expect } from "vitest";
import tokensRaw from "../shadcn.css?raw";
import indexHtmlRaw from "../../index.html?raw";

// CSS 变量引用契约：组件里无 fallback 的 var(--x) 必须在 shadcn.css / index.html
// 有定义。曾出现 ExpenseBreakdownSection 引用从未定义的 --positive-600/--negative-600，
// 声明静默失效、环比红绿着色在生产上从未生效，且无任何构建/测试报错。
//
// 白名单：
// - --radix-*：Radix UI 运行时注入到触发器内联样式，源码里本就没有定义点。
// （原 legacyClasses.ts 的 --primary-50/300/700 白名单已于 2026-10-18 旧 token 迁移中
//   随那三条未定义引用一并清除，此处不再保留任何文件级豁免。）

const RADIX_PREFIX = "radix-";

function definedNames(): Set<string> {
  const names = new Set<string>();
  for (const raw of [tokensRaw, indexHtmlRaw]) {
    for (const m of raw.matchAll(/--([a-z0-9][a-z0-9-]*)\s*:/gi)) {
      names.add(m[1].toLowerCase());
    }
  }
  return names;
}

// eager 原始读取全部源码；键形如 ../components/Foo.tsx，归一化为 src/ 相对路径。
const sources = import.meta.glob("../**/*.{ts,tsx,css}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("CSS 变量引用契约：无 fallback 的 var(--x) 必须有定义点", () => {
  it("源码中不存在未定义且无 fallback 的变量引用", () => {
    const defined = definedNames();
    const violations: string[] = [];

    for (const [key, src] of Object.entries(sources)) {
      const normPath = key.replace(/^\.\.\//, "src/");
      if (/\.test\.[tj]sx?$|tests\/setup\.ts$/.test(normPath)) continue;

      for (const m of src.matchAll(/var\(\s*--([a-z0-9][a-z0-9-]*)([^)]*)\)/gi)) {
        const name = m[1].toLowerCase();
        const hasFallback = m[2].includes(",");
        if (hasFallback || defined.has(name)) continue;
        if (name.startsWith(RADIX_PREFIX)) continue;
        violations.push(`${normPath}: --${name}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
