/**
 * 共享精确十进制原语（BigInt 精确定点）。
 *
 * 本模块是仓内**唯一的**金额运算底座：凡是涉及「金额判定」的路径（余额比较、
 * 破线检测、勾稽门禁）都必须走这里，绝不能用 `Number()` 做判定，
 * 否则浮点残差会在 `===` 判定上制造假阴/假阳。
 *
 * 设计：ScaledDecimal = { units: bigint; scale: number }，即 units 为把原数
 * 放大 10^scale 倍后的整数。所有运算在整数域内精确进行，零舍入、零量化。
 *
 * 本模块从 `waterfallReconciliation.ts` 原样搬迁而来（详见该文件的兼容 shim），
 * 搬迁不改任何行为：纯只读观察端的「金额绝不用浮点做判定」铁律在此落地。
 */

/** 精确定点十进制：units 为放大 10^scale 倍后的整数。 */
export interface ScaledDecimal {
  units: bigint;
  scale: number;
}

/**
 * 把十进制字符串解析为精确定点表示。
 * 例：parseDecimal("-15234.567891") → { units: -15234567891n, scale: 6 }。
 * 非法 / 空串 / 仅符号返回 null（**不返回 0**：缺失与零必须区分，否则门禁会把
 * "字段缺失" 误当 "零"，从而放过不完整的数据）。
 */
export function parseDecimal(s: unknown): ScaledDecimal | null {
  if (s === null || s === undefined) return null;
  const str = String(s).trim();
  if (str === "" || str === "+" || str === "-") return null;
  const m = /^([+-]?)(\d*)(?:\.(\d+))?$/.exec(str);
  if (!m) return null;
  const sign = m[1] === "-" ? -1n : 1n;
  const intPart = m[2] ?? "";
  const fracPart = m[3] ?? "";
  const combined = `${intPart}${fracPart}`;
  if (combined === "") return null;
  const units = sign * BigInt(combined);
  return { units, scale: fracPart.length };
}

/** 把若干操作数对齐到公共 scale（取各自 scale 的最大值）后再运算。 */
function alignScales(items: ScaledDecimal[]): { units: bigint[]; scale: number } {
  let maxScale = 0;
  for (const it of items) if (it.scale > maxScale) maxScale = it.scale;
  const units = items.map((it) => {
    const diff = maxScale - it.scale;
    return diff === 0 ? it.units : it.units * 10n ** BigInt(diff);
  });
  return { units, scale: maxScale };
}

/** 精确求和（不丢亚分精度）。 */
export function decSum(items: ScaledDecimal[]): ScaledDecimal {
  if (items.length === 0) return { units: 0n, scale: 0 };
  const { units, scale } = alignScales(items);
  const total = units.reduce((a, b) => a + b, 0n);
  return { units: total, scale };
}

/** 精确求差 a − b。 */
export function decDiff(a: ScaledDecimal, b: ScaledDecimal): ScaledDecimal {
  const { units, scale } = alignScales([a, b]);
  return { units: units[0] - units[1], scale };
}

/** 精确相等（bigint === bigint，零容差）。 */
export function decEquals(a: ScaledDecimal, b: ScaledDecimal): boolean {
  const { units } = alignScales([a, b]);
  return units[0] === units[1];
}

/** 精确取较小值。 */
export function decMin(a: ScaledDecimal, b: ScaledDecimal): ScaledDecimal {
  const { units, scale } = alignScales([a, b]);
  return units[0] <= units[1] ? { units: units[0], scale } : { units: units[1], scale };
}

/** 精确绝对值。 */
export function decAbs(a: ScaledDecimal): ScaledDecimal {
  return { units: a.units < 0n ? -a.units : a.units, scale: a.scale };
}

/**
 * 精确三态比较：a < b 返回 -1，a === b 返回 0，a > b 返回 1。
 * 注意：不能用 `Number(units[0] - units[1])` 把 bigint 差值塞进 number——
 * 当金额很大（超出 2^53）时 number 会丢精度，比较结果失真。必须在 bigint 域内
 * 比较后返回字面量 -1 / 0 / 1。
 */
export function decCompare(a: ScaledDecimal, b: ScaledDecimal): number {
  const { units } = alignScales([a, b]);
  if (units[0] < units[1]) return -1;
  if (units[0] > units[1]) return 1;
  return 0;
}

/**
 * 把精确十进制还原成十进制字符串：**只做表示转换**——不量化、不四舍五入、不加
 * 千分位（尾随零按规范化剥掉）。要 2 位展示口径请走 format.ts 的
 * formatNumber / quantize2（CALC-02）。
 * 例：{ units: 150n, scale: 2 } → "1.5"；{ units: -123456n, scale: 6 } → "-0.123456"。
 */
export function formatDecimal(d: ScaledDecimal): string {
  const neg = d.units < 0n;
  const mag = neg ? -d.units : d.units;
  if (d.scale === 0) return (neg ? "-" : "") + mag.toString();
  const digits = mag.toString().padStart(d.scale + 1, "0");
  const intPart = digits.slice(0, digits.length - d.scale);
  let fracPart = digits.slice(digits.length - d.scale).replace(/0+$/, "");
  const sign = neg && mag !== 0n ? "-" : "";
  return fracPart ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

/** 十进制 → number（**仅供 ECharts 渲染柱高**，不参与任何判定路径）。 */
export function decToNumber(d: ScaledDecimal): number {
  return Number(formatDecimal(d));
}

/** 降序比较（用于前端按 amount_base 重排）。 */
export function decCompareDesc(a: ScaledDecimal, b: ScaledDecimal): number {
  const { units } = alignScales([a, b]);
  if (units[1] < units[0]) return -1;
  if (units[1] > units[0]) return 1;
  return 0;
}
