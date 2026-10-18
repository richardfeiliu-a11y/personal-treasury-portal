// 金额格式化与遮蔽。金额在 Bridge 中始终是字符串 Decimal；
// 遮蔽偏好只存 localStorage，绝不上传服务器（实施文档 §6.3）。

import { parseDecimal } from "./decimal";

const nf = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctNf = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

// 负零（-0）经 Intl 会渲染成 "-0.00"，统一归一为正零。
function normalizeZero(num: number): number {
  return Object.is(num, -0) ? 0 : num;
}

/**
 * WP06/U02 + Batch09/CALC-02：字符串十进制走精确路径（不经过 Number）——
 * >2^53 的金额经 Number 会丢精度（如 10000000000000001.5 → ...002.00）。
 *
 * 共享量化规则：固定 2 位小数、ROUND_HALF_UP（只看被舍弃的第 3 位），全程在
 * 十进制字符串域完成。**金额串（Bridge Decimal 字符串）的展示量化只有这一处**——
 * formatNumber 的 string 分支、formatAmount / formatSigned、delta 计算
 * （balanceSheetDelta）与汇总卡差值（BalanceSheet renderDiff）都复用它，保证
 * 「差值字符串」与卡片数字不会因走 toFixed / Intl 两条不同实现而差一分。
 * number 入参仍走 nf（Intl）分支：汇率、占比、目标值等既有浮点路径不属于本口径。
 *
 * 返回无千分位的 `"12.35"` / `"-1.01"`；恰好量化为 0 时剥掉负号（`"-0.00"` 是
 * 假跌信号，与 normalizeZero 同一口径）；非法输入返回 null，由调用方决定占位符。
 */
export function quantize2(raw: string): string | null {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? "-" : "";
  const intPart = m[2];
  const frac = m[3] ?? "";
  let carry = 0n;
  let frac2 = frac.slice(0, 2).padEnd(2, "0");
  if (frac.length > 2) {
    // 第 3 位半进位：单个 ASCII 数字比较即可，无需经 Number。
    carry = frac[2] >= "5" ? 1n : 0n;
    const merged = BigInt(frac.slice(0, 2) || "0") + carry;
    if (merged >= 100n) {
      carry = 1n;
      frac2 = "00";
    } else {
      frac2 = String(merged).padStart(2, "0");
      carry = 0n;
    }
  }
  const intWithCarry = BigInt(intPart) + carry;
  const isZero = intWithCarry === 0n && /^0*$/.test(frac2);
  return (isZero ? "" : sign) + intWithCarry.toString() + "." + frac2;
}

/** 已量化（2 位小数、无分隔）的字符串 → zh-CN 千分位分组。仅内部使用。 */
function groupQuantized(quantized: string): string {
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(quantized);
  if (!m) return "—";
  const grouped = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return m[1] + grouped + "." + m[3];
}

function formatDecimalString(raw: string): string {
  const quantized = quantize2(raw);
  return quantized === null ? "—" : groupQuantized(quantized);
}

export function formatNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return formatDecimalString(value);
  const num = value;
  if (!Number.isFinite(num)) return "—";
  return nf.format(normalizeZero(num));
}

export function formatAmount(value: string | null | undefined, currency: string): string {
  if (value === null || value === undefined) return "汇率缺失";
  return `${formatNumber(value)} ${currency}`;
}

export function formatSigned(value: string | null | undefined, currency: string): string {
  if (value === null || value === undefined) return "汇率缺失";
  // "" 不落回「汇率缺失」而是走 formatNumber 的占位符 "—"：缺失与零必须区分，
  // 空串绝不能被渲染成 0.00（与 parseDecimal 同一立场）。
  // Batch09/CALC-02：判号走字符串（parseDecimal 的 units 符号），绝不经 Number()。
  // 旧实现 `Number(value) < 0` + `Math.abs(num)` 在 >2^53 的金额上（该量级 ulp = 2）
  // 会同时改掉低位数字与亚分位："10000000000000001.5" → "10,000,000,000,000,002.00"。
  // 口径：恰好为 0（含 "-0"、"-0.00"）不带负号——与 normalizeZero 一致；
  // 而 "-0.004" 这类量化后才归零的小额流出仍保留 −，因为方向本身就是信息。
  const raw = value.trim();
  const parsed = parseDecimal(raw);
  const negative = parsed !== null && parsed.units < 0n;
  const magnitude = raw.replace(/^[-+]/, "");
  return `${negative ? "−" : ""}${formatNumber(magnitude)} ${currency}`;
}

export function formatPct(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return "—";
  return `${pctNf.format(normalizeZero(num))}%`;
}

const MASK = "••••";

export function maskAmount(text: string): string {
  // 遮蔽时保留币种代码，仅遮蔽数字部分
  return text.replace(/[\d,.\-−]+/g, MASK);
}

export function loadMaskPreference(storage: Storage = localStorage): boolean {
  return storage.getItem("report-web.mask") === "1";
}

export function saveMaskPreference(masked: boolean, storage: Storage = localStorage): void {
  storage.setItem("report-web.mask", masked ? "1" : "0");
}
