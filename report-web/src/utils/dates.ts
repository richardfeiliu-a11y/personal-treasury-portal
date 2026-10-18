// 日期工具：所有区间计算以"本地日历日"为准（后端按 Europe/Berlin 计算，前端同口径）
//
// WP05（R05/R06/U05）：金融日期一律按 Europe/Berlin 业务日历解析，禁止依赖
// 浏览器所在时区推算金融区间。berlin* 系列是唯一允许参与金融请求参数来源的
// 入口；跨页钻取必须显式传递同一期间对象。

/** 宿主时区当天 ISO 日期。仅限展示（如日历「今天」高亮）；
 *  金融请求参数必须用 berlinTodayIso（DATA-01 铁律，见文件头注释）。 */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayIso(d);
}

/** 最近 N 天区间（含今天），例如最近30天 = [今天-29, 今天]。 */
export function lastNDays(n: number, now: Date = new Date()): { start: string; end: string } {
  const end = todayIso(now);
  return { start: addDays(end, -(n - 1)), end };
}

/** 本月区间。 */
export function currentMonth(now: Date = new Date()): { start: string; end: string } {
  const end = todayIso(now);
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  return { start, end };
}

/** 今年区间。 */
export function currentYear(now: Date = new Date()): { start: string; end: string } {
  return { start: `${now.getFullYear()}-01-01`, end: todayIso(now) };
}

/** 某一 iso 日期所在月的月末。 */
export function monthEnd(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** 上月末（如 2026-08-16 → 2026-07-31；年初 2026-01-05 → 2025-12-31）。
 *  宿主时区版：仅供 prevMonthEnd 这类「对既有 ISO 串做纯日历运算」与展示复用；
 *  由「今天」推导并写入金融请求参数时必须用 berlinLastMonthEnd（DATA-01）。 */
export function lastMonthEnd(now: Date = new Date()): string {
  return todayIso(new Date(now.getFullYear(), now.getMonth(), 0));
}

/** 去年末（如 2026-08-16 → 2025-12-31）。宿主时区版，约束同 lastMonthEnd。 */
export function lastYearEnd(now: Date = new Date()): string {
  return `${now.getFullYear() - 1}-12-31`;
}

/** 某 iso 日期所在月的上月末（2026-08-07 → 2026-07-31；2026-01-05 → 2025-12-31）。 */
export function prevMonthEnd(iso: string): string {
  return lastMonthEnd(new Date(`${iso}T00:00:00`));
}

/** 某 iso 日期所在年的去年末（2026-08-07 → 2025-12-31）。 */
export function prevYearEnd(iso: string): string {
  return lastYearEnd(new Date(`${iso}T00:00:00`));
}

/** 上月完整区间（1 日 ~ 月末）。 */
export function lastMonth(now: Date = new Date()): { start: string; end: string } {
  const end = lastMonthEnd(now);
  return { start: `${end.slice(0, 7)}-01`, end };
}

/** 最近 N 个月的每月月末（升序，不含本月）。用于期间趋势图。 */
export function lastNMonthEnds(n: number, now: Date = new Date()): string[] {
  const result: string[] = [];
  const cur = now.getFullYear() * 12 + now.getMonth();
  for (let i = n; i >= 1; i--) {
    const idx = cur - i;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    result.push(monthEnd(`${y}-${String(m).padStart(2, "0")}-01`));
  }
  return result;
}

/** 把日期平移 delta 个月；月末自动收敛（如 3-31 → 2-28）。 */
export function shiftMonths(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const lastDay = new Date(ny, nm, 0).getDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** 计算期间的上期对比区间（P1 修复：按期间类型而非固定 30 天）。 */
export function previousPeriod(
  start: string,
  end: string,
  kind: "days" | "month" | "year",
): { start: string; end: string } {
  if (kind === "month") {
    return { start: shiftMonths(start, -1), end: shiftMonths(end, -1) };
  }
  if (kind === "year") {
    return { start: shiftMonths(start, -12), end: shiftMonths(end, -12) };
  }
  // days（含自定义）：等长的前一窗口
  const lenDays = Math.round((new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime()) / 86_400_000) + 1;
  const prevEnd = addDays(start, -1);
  return { start: addDays(prevEnd, -(lenDays - 1)), end: prevEnd };
}

export function formatDateCn(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(y)}年${Number(m)}月${Number(d)}日`;
}

// ---------------------------------------------------------------------------
// Europe/Berlin 业务期间（WP05）
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 某一瞬间在 Europe/Berlin 的日历日期三要素（不依赖宿主时区）。 */
export function berlinDateParts(instant: Date = new Date()): { y: number; m: number; d: number } {
  // en-CA 输出 YYYY-MM-DD，稳定且不依赖宿主 locale
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
  const [y, m, d] = formatted.split("-").map(Number);
  return { y, m, d };
}

/** Europe/Berlin 当天 ISO 日期（金融"今天"）。 */
export function berlinTodayIso(instant: Date = new Date()): string {
  const { y, m, d } = berlinDateParts(instant);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Europe/Berlin 本月至今区间（金融月份起点用柏林日历，不用宿主时区）。 */
export function berlinCurrentMonth(instant: Date = new Date()): { start: string; end: string } {
  const end = berlinTodayIso(instant);
  return { start: `${end.slice(0, 7)}-01`, end };
}

/** Europe/Berlin 最近 N 天区间（含柏林今天）。RV-05：预设不得用浏览器时区。 */
export function berlinLastNDays(n: number, instant: Date = new Date()): { start: string; end: string } {
  const end = berlinTodayIso(instant);
  return { start: addDays(end, -(n - 1)), end };
}

/** Europe/Berlin 上月末（如柏林 2026-09-01 → 2026-08-31；柏林年初 → 上年 12-31）。
 *  DATA-01：任何写入 as_of 的「上月末」必须走本函数而非宿主时区版 lastMonthEnd。 */
export function berlinLastMonthEnd(instant: Date = new Date()): string {
  const { y, m } = berlinDateParts(instant);
  const idx = y * 12 + (m - 1) - 1;
  const py = Math.floor(idx / 12);
  const pm = (idx % 12) + 1;
  return monthEnd(`${py}-${String(pm).padStart(2, "0")}-01`);
}

/** Europe/Berlin 上月完整区间（按柏林日历定月份）。 */
export function berlinLastMonth(instant: Date = new Date()): { start: string; end: string } {
  const end = berlinLastMonthEnd(instant);
  return { start: `${end.slice(0, 7)}-01`, end };
}

/** Europe/Berlin 去年末（如柏林 2026-08-16 → 2025-12-31）。 */
export function berlinLastYearEnd(instant: Date = new Date()): string {
  const { y } = berlinDateParts(instant);
  return `${y - 1}-12-31`;
}

/** Europe/Berlin 最近 N 个月的每月月末（升序，不含柏林本月）。
 *  DATA-01：逐月趋势的每个月末会直接成为 start_date/end_date 请求参数。 */
export function berlinLastNMonthEnds(n: number, instant: Date = new Date()): string[] {
  const { y, m } = berlinDateParts(instant);
  const cur = y * 12 + (m - 1);
  const result: string[] = [];
  for (let i = n; i >= 1; i--) {
    const idx = cur - i;
    const py = Math.floor(idx / 12);
    const pm = (idx % 12) + 1;
    result.push(monthEnd(`${py}-${String(pm).padStart(2, "0")}-01`));
  }
  return result;
}

/** Europe/Berlin 今年至今区间（按柏林日历定年份）。 */
export function berlinCurrentYear(instant: Date = new Date()): { start: string; end: string } {
  const end = berlinTodayIso(instant);
  return { start: `${end.slice(0, 4)}-01-01`, end };
}

/** 真实日历日校验：形状合法且该日期真实存在（RV-05：拒绝 2026-02-30 类输入）。 */
export function isRealCalendarDate(iso: string): boolean {
  if (!ISO_DATE_RE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export type PeriodResult = { start: string; end: string; error?: string };

/**
 * 解析深链/共享期间（WP05 任务 3）：非法输入返回显式 error，不静默回退。
 * - 两者皆空 → Berlin 本月至今（显式默认，非猜测）
 * - 非 ISO 串 / 起>止 → 携带 error，调用方必须展示错误说明
 */
export function resolveBusinessPeriod(
  start: string | null | undefined,
  end: string | null | undefined,
  instant: Date = new Date(),
): PeriodResult {
  if (!start && !end) {
    return berlinCurrentMonth(instant);
  }
  if (!ISO_DATE_RE.test(start ?? "") || !ISO_DATE_RE.test(end ?? "")) {
    return { start: start ?? "", end: end ?? "", error: "日期格式应为 YYYY-MM-DD" };
  }
  // RV-05：只验形状会放行 2026-02-30 并向 API 请求不存在的日期——必须校验真实日历日。
  if (!isRealCalendarDate(start!) || !isRealCalendarDate(end!)) {
    return { start: start!, end: end!, error: "日期不存在，请检查日历日期" };
  }
  if (start! > end!) {
    return { start: start!, end: end!, error: "起始日期不能晚于截止日期" };
  }
  return { start: start!, end: end! };
}
