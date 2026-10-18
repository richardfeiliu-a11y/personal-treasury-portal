// BalanceSheet 环比 Delta 计算（规格 §2.3 Feature 3 财务门禁）：
// - 账户按稳定 account.id 对齐（调用方负责传入同一 id 的 current/compare 行）；
// - 任一侧 balance_base 为 null（汇率不完整）→ delta 一律为 null，严禁把 null 当 0 相减；
// - 上期无余额 / 本期有余额 → "new"；上期有余额 / 本期无余额 → "closed"；
// - 涨跌指示只输出中性箭头（↑ / ↓），不做红绿语义暗示；
// - 差值在 decimal.ts 的 BigInt 精确域计算，量化口径与 format.ts 共用（CALC-02）。

import type { WebAccountRow } from "../api/types";
import { decDiff, formatDecimal, parseDecimal } from "./decimal";
import { quantize2 } from "./format";

export type CompareMode = "none" | "last_month_end" | "last_year_end";

export interface AccountDeltaResult {
  current_balance: string | null;
  compare_balance: string | null;
  /** current − compare 的精确差值，按展示口径量化到 2 位；汇率不完整/新增/退出时为 null。 */
  diff_amount: string | null;
  /** (current − compare) / |compare| * 100，保留 1 位小数；不可算时为 null。 */
  diff_percentage: number | null;
  status: "normal" | "new" | "closed" | "fx_incomplete";
}

/**
 * 数值是否为 0（"0"、"0.00"、"0.0000" 均视为零余额）。
 * Batch09/CALC-02：判定走字符串域（parseDecimal 的 units 恰为 0n），不用
 * `Number(v) === 0`——金额判定路径一律禁止浮点（见 decimal.ts 模块说明）。
 * 无法解析时按「非零」处理：宁可继续走差值分支，也不凭猜测量把账户判成新增/退出。
 */
function isZero(value: string | null): boolean {
  if (value === null) return true;
  const parsed = parseDecimal(value);
  return parsed !== null && parsed.units === 0n;
}

export function calculateAccountDelta(
  current: WebAccountRow,
  compare?: WebAccountRow,
): AccountDeltaResult {
  const currentBase = current.balance_base;
  const compareBase = compare?.balance_base ?? null;

  // 汇率不完整门禁：任一侧 balance_base 为 null → 差值与百分比必须为 null。
  // 注意：compare 行整体缺失（undefined）不算 fx_incomplete，走新增/退出分支。
  if (currentBase === null || (compare !== undefined && compareBase === null)) {
    return {
      current_balance: currentBase,
      compare_balance: compareBase,
      diff_amount: null,
      diff_percentage: null,
      status: "fx_incomplete",
    };
  }

  // 新增 / 退出账户：只按是否为零余额判定，禁止显示 +∞%。
  if (compare === undefined || isZero(compareBase)) {
    return {
      current_balance: currentBase,
      compare_balance: compareBase,
      diff_amount: null,
      diff_percentage: null,
      status: isZero(currentBase) ? "closed" : "new",
    };
  }
  if (isZero(currentBase)) {
    return {
      current_balance: currentBase,
      compare_balance: compareBase,
      diff_amount: null,
      diff_percentage: null,
      status: "closed",
    };
  }

  // Batch09/CALC-02：差值走 BigInt 精确定点域，不再 `Number(a) - Number(b)`。
  // 浮点在 >2^53 或亚分输入上会把差值整个抹掉，例如
  //   10000000000000001.5 − 10000000000000002.25 精确为 −0.75，
  // 而两操作数在 [2^53, 2^54)（ulp = 2）下都舍成 10000000000000002 → 旧实现给 "0.00"。
  // 展示量化复用 format.ts 的 quantize2（2 位、ROUND_HALF_UP、归零剥负号），与
  // formatNumber/formatSigned 同一口径；formatDecimal 只把 BigInt 定点还原成十进制
  // 串（并归一化尾随零），本身不量化，所以量化必须在 quantize2 这一步完成。
  const curr = parseDecimal(currentBase);
  const comp = parseDecimal(compareBase);
  if (curr === null || comp === null) {
    // 脏数据（非纯十进制串）宁可为 null 显示 "—"，也不输出 "NaN" 冒充金额。
    return {
      current_balance: currentBase,
      compare_balance: compareBase,
      diff_amount: null,
      diff_percentage: null,
      status: "normal",
    };
  }
  const exactDiff = formatDecimal(decDiff(curr, comp));
  const diffAmount = quantize2(exactDiff);

  // 百分比按方案保留 float：它只是箭头旁的展示数字（1 位小数），不参与任何门禁
  // 判定，故允许浮点。分子用上面的精确差值串，分母取 |compare|（负余额如信用卡
  // 欠款时方向符号依旧正确）。
  const pct = (Number(exactDiff) / Math.abs(Number(compareBase))) * 100;
  return {
    current_balance: currentBase,
    compare_balance: compareBase,
    diff_amount: diffAmount,
    diff_percentage: Math.round(pct * 10) / 10,
    status: "normal",
  };
}
