export type TrendDirection = "higher-is-better" | "lower-is-better";
export type TrendTone = "positive" | "negative" | "neutral";

export function trendTone(value: string | null, direction: TrendDirection): TrendTone {
  if (value === null) return "neutral";
  const numeric = Number(value.replace("%", "").replace("−", "-"));
  if (!Number.isFinite(numeric) || numeric === 0) return "neutral";
  const favorable = direction === "higher-is-better" ? numeric > 0 : numeric < 0;
  return favorable ? "positive" : "negative";
}

export function pctChange(cur: string | null | undefined, prev: string | null | undefined): string | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  const c = Number(cur);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  const pct = ((c - p) / Math.abs(p)) * 100;
  // 先取整再判符号：避免 -0.4% 渲染成 "-0%"；取整后为零则返回 null，由调用方显示 "—"。
  const rounded = Number(pct.toFixed(0));
  if (rounded === 0) return null;
  const sign = rounded > 0 ? "+" : "-";
  return `${sign}${Math.abs(rounded)}%`;
}
