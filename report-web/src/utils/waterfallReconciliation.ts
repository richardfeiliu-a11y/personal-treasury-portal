import type { ReportEnvelope, ReportSectionRow } from "../api/types";
import {
  type ScaledDecimal,
  parseDecimal,
  decSum,
  decDiff,
  decEquals,
  decMin,
  decAbs,
  formatDecimal,
  decToNumber,
  decCompareDesc,
} from "./decimal";

/**
 * 收支瀑布图「勾稽门禁」核心逻辑（Task 2.1）。
 *
 * 商业语义：瀑布图从总收入起跳，逐笔扣减支出分类，最终必须精确等于后端权威的
 * 「本期净结余」。一旦画出来，就等于宣告"我对平了"——所以对不平时绝不画一张
 * 看似正确的假图，而是阻断并披露差额，把问题暴露给能修的人。
 *
 * 精度约束（R-D18）：后端 `decimal_text` 不做量化，`amount_base` 可能带亚分精度
 * （如 "15234.567891"）。因此勾稽判定一律走 BigInt 精确定点，零容差：
 *   - 不能用浮点：Number() 累加会引入 ~1e-10 残差，===0 必误判；
 *   - 不能先 round(x*100) 再求和：sum-of-rounded ≠ rounded-of-sum，会凭空造出
 *     1 分差额，导致门禁在真实数据上误报阻断（这正是本任务的隐藏陷阱）。
 * 图表消费的 `base`/`value` 是 number（ECharts 只吃 number），仅供渲染；
 * 判定路径（G0~G3）一律用下面的十进制工具，绝不参与浮点。
 *
 * 数据结构约束（R-D2）：本仓库没有 `IncomeExpenseReport` 顶层类型，`summary` 是
 * `Record<string, unknown>`。这里用一个薄视图类型 `IncomeStatementSummaryView`
 * 来窄化它，不新建虚构类型、不改 `types.ts`。
 */

/** 窄化 ReportEnvelope.summary（R-D2：summary 是 Record<string, unknown>）。 */
export interface IncomeStatementSummaryView {
  total_income_cny?: string | null;
  total_expenses_cny?: string | null;
  net_result_cny?: string | null;
}

export interface WaterfallStep {
  label: string;
  /** 权威十进制字符串（原样或精确格式化，不经浮点回环）。 */
  amount: string;
  type: "income" | "expense" | "total";
  /** 透明垫底柱高度，仅供 ECharts。 */
  base: number;
  /** 可见柱高度，仅供 ECharts。 */
  value: number;
}

export interface WaterfallReconciledData {
  is_complete: boolean;
  /** 汇率不完整时为 true */
  fx_incomplete: boolean;
  steps: WaterfallStep[];
  /** 门禁未通过时的中文原因（含差额数字）；通过时为 null。 */
  error: string | null;
  base_currency: string;
}

const blocked = (error: string, base: string): WaterfallReconciledData => ({
  is_complete: false,
  fx_incomplete: false,
  steps: [],
  error,
  base_currency: base,
});

/**
 * 勾稽并构造收支瀑布图 steps。
 * topN 只影响「其他支出」之外展示多少条分类，**不影响勾稽**——G3 校验的是全部行之和。
 */
export function reconcileWaterfallData(report: ReportEnvelope, topN = 5): WaterfallReconciledData {
  const base = report.base_currency ?? "CNY";

  // ---- G0 结构完整性 ----
  const summary = (report.summary ?? {}) as IncomeStatementSummaryView;
  const tiRaw = summary.total_income_cny;
  const teRaw = summary.total_expenses_cny;
  const nrRaw = summary.net_result_cny;
  if (
    tiRaw === null || tiRaw === undefined || tiRaw === "" ||
    teRaw === null || teRaw === undefined || teRaw === "" ||
    nrRaw === null || nrRaw === undefined || nrRaw === ""
  ) {
    return blocked("数据不完整：收入/支出/净结余任一权威合计缺失（null/空串），无法勾稽。", base);
  }
  const tiD = parseDecimal(tiRaw);
  const teD = parseDecimal(teRaw);
  const nrD = parseDecimal(nrRaw);
  if (!tiD || !teD || !nrD) {
    return blocked("数据不完整：收入/支出/净结余权威合计无法解析为十进制，无法勾稽。", base);
  }

  // ---- 取「收支报表自身」的 expenses 节（R-D15：严禁取 expense-breakdown 的 top_expenses）----
  // 这里直接消费 income-statement 回包（同一次累加），门禁才有意义；
  // 若取截断的 Top-N 行再令 其他支出=总支出−TopN，等式恒成立 => 假门禁（tautology）。
  const expenseSection = (report.sections ?? []).find((s) => s.key === "expenses");
  if (!expenseSection) {
    return blocked("数据不完整：未找到 expenses 明细节，无法对平权威总支出。", base);
  }

  // ---- G1 汇率完整性 ----
  // spec §9 / WP4 Step 4：缺 FX 时 inline micro-alert（非全屏阻断），图表仍渲染可用数据。
  const allExpenseRows = expenseSection.rows ?? [];
  const availableExpenseRows = allExpenseRows.filter(
    (r) => r.amount_base !== null && r.amount_base !== undefined && r.amount_base !== "",
  );
  const fxIncomplete = report.fx_complete === false || availableExpenseRows.length < allExpenseRows.length;
  const expenseRows = availableExpenseRows;
  if (expenseRows.length === 0 && allExpenseRows.length > 0) {
    return { ...blocked("汇率不完整：所有支出明细均缺汇率，无法构建瀑布图步骤。", base), fx_incomplete: true };
  }

  // ---- G2 合计内部一致：总收入 − 总支出 === 净结余 ----
  const expectedNet = decDiff(tiD, teD);
  if (!decEquals(expectedNet, nrD)) {
    const diff = decAbs(decDiff(expectedNet, nrD));
    return blocked(
      `合计内部不一致：总收入 − 总支出 = ${formatDecimal(expectedNet)} ${base}，` +
        `与权威净结余 ${formatDecimal(nrD)} ${base} 差 ${formatDecimal(diff)} ${base}。`,
      base,
    );
  }

  // ---- G3 明细对平合计 ----
  // FX 完整时：核心门禁；FX 不完整时：跳过（部分行被过滤）
  if (!fxIncomplete) {
    const detailDecimals = expenseRows
      .map((r) => parseDecimal(r.amount_base as string))
      .filter((d): d is ScaledDecimal => d !== null);
    const detailSum = decSum(detailDecimals);
    if (!decEquals(detailSum, teD)) {
      const diff = decAbs(decDiff(detailSum, teD));
      return blocked(
        `明细合计与权威总支出差 ${formatDecimal(diff)} ${base}` +
          `（明细 Σ=${formatDecimal(detailSum)} ${base}，权威总支出=${formatDecimal(teD)} ${base}）。`,
        base,
      );
    }
  } // end !fxIncomplete

  // ===== 全部通过：构造 steps =====
  // label 消歧：同一分类名可能按 (分类, 币种) 拆成多行，重名时追加 " (币种)"。
  const labelCounts = new Map<string, number>();
  for (const r of expenseRows) labelCounts.set(r.label, (labelCounts.get(r.label) ?? 0) + 1);
  const labelOf = (r: ReportSectionRow): string =>
    (labelCounts.get(r.label) ?? 0) > 1 ? `${r.label} (${r.currency})` : r.label;

  // 前端自己按 amount_base 降序重排（R-D15：后端按原币降序，跨币种可能与折 CNY 排序不同）。
  const sorted = [...expenseRows].sort((a, b) => {
    const da = parseDecimal(a.amount_base as string);
    const db = parseDecimal(b.amount_base as string);
    if (!da || !db) return 0;
    return decCompareDesc(da, db);
  });

  const n = Math.max(0, topN);
  const topRows = sorted.slice(0, n);
  void sorted.slice(n);
  // 3. 其他支出：总支出 − Σ(TopN 行金额)
  // 包含 TopN 之外 + 缺汇率行（FX 不完整时）
  const topSum = decSum(
    topRows.map((r) => parseDecimal(r.amount_base as string)).filter((d): d is ScaledDecimal => d !== null),
  );
  const otherD = decDiff(teD, topSum);
  const hasOther = otherD.units !== 0n;

  const steps: WaterfallStep[] = [];
  let running: ScaledDecimal = tiD;

  const pushStep = (
    label: string,
    amount: string,
    type: WaterfallStep["type"],
    before: ScaledDecimal,
    after: ScaledDecimal,
  ) => {
    // 跨零安全几何：base = min(before, after)，value = |after − before|
    const baseD = decMin(before, after);
    const valueD = decAbs(decDiff(after, before));
    steps.push({
      label,
      amount,
      type,
      base: decToNumber(baseD),
      value: decToNumber(valueD),
    });
  };

  // 1. 总收入
  pushStep("总收入", tiRaw, "income", { units: 0n, scale: 0 }, tiD);

  // 2. Top N 支出（按 amount_base 降序）
  for (const r of topRows) {
    const d = parseDecimal(r.amount_base as string);
    if (!d) continue;
    const before = running;
    const after = decDiff(running, d);
    pushStep(labelOf(r), r.amount_base as string, "expense", before, after);
    running = after;
  }

  // 3. 其他支出（确需时）
  if (hasOther) {
    const before = running;
    const after = decDiff(running, otherD);
    pushStep("其他支出", formatDecimal(otherD), "expense", before, after);
    running = after;
  }

  // 4. 本期净结余：取权威 net_result_cny，**不**用累加结果（落地须恰好等于权威净结余）。
  pushStep("本期净结余", nrRaw, "total", { units: 0n, scale: 0 }, nrD);

  return { is_complete: true, fx_incomplete: fxIncomplete, steps, error: null, base_currency: base };
}
