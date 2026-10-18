import { isRealCalendarDate } from "./dates";

/**
 * REL-05：时间戳呈现的唯一入口。后端两类新鲜度字段语义不同，禁止混用：
 * - 瞬间（generated_at / checked_at：带时间的 ISO 8601）→ formatTimestampBerlin
 * - 纯日历日（as_of / balance_as_of / fx_rates_date：YYYY-MM-DD）→ formatCalendarDate
 *
 * 口径说明：本应用金融日期一律按 Europe/Berlin 业务日历（DATA-01 铁律），
 * 所以「数据生成时间」也以柏林时刻呈现并由调用方显式标注时区，
 * 不用浏览器时区渲染却声称另一时区。
 * formatTimestampLocal（宿主时区呈现）已删除：它唯一的使用点是 Alerts 页首的
 * 「检查时间」，而同页页脚呈现的是同一瞬间的柏林口径读数——两种口径并排必然误导。
 */

/**
 * 含时刻且**显式携带偏移量**的 ISO 8601 瞬间：
 * "2026-08-09T10:00:00+00:00" / "2026-08-09T10:00:00Z" / "2026-08-09T10:00+02:00"。
 *
 * 缺偏移量的输入一律拒绝（返回 "—"）：`new Date("2026-08-09T10:00")` 按**宿主时区**
 * 解析成瞬间，输出却标注 Europe/Berlin——同一串在不同浏览器上呈现不同结果，
 * 且呈现口径与声明口径不符。后端 instant 一律由 UTC 产出并带偏移量，
 * 因此收紧只会挡掉真正有问题的输入，不影响线上数据。
 *
 * 文法按 ES `Date-Time String Format` 的**大小写敏感**子集：日期与时刻的分隔符只认
 * `T`/空格（不认 `t`），UTC 标记只认 `Z`（不认 `z`），偏移量的 `+hh:mm` 必须带冒号
 * （不认 `+0000`）。`new Date()` 对这些变体同样宽容（实测 "…10:00:00z" 可解析），
 * 宽容度必须由这里显式声明，否则等于把文法交给引擎版本决定。
 */
const INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** ISO 日历日（YYYY-MM-DD 且真实存在）→ 原样回显；不做时区换算，非法则 "—"。 */
export function formatCalendarDate(iso: string | undefined | null): string {
  if (!iso || !isRealCalendarDate(iso)) return "—";
  return iso;
}

/**
 * ISO 瞬间 → "YYYY-MM-DD HH:MM"（Europe/Berlin）。
 * 纯日历日不在这里猜时刻：`new Date("2026-08-09")` 会被解释为 UTC 午夜，
 * 再按柏林时区偏移就凭空造出一个不存在的渲染时间，故此类输入返回 "—"，
 * 调用方必须改用 formatCalendarDate。
 */
export function formatTimestampBerlin(iso: string | undefined | null): string {
  if (!iso || !INSTANT_RE.test(iso)) return "—";
  const d = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  // 个别 ICU 在 hour12:false 下把午夜输出为 "24"
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
}
