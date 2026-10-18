/**
 * 构成分析 V1 的纯计算层（spec §4 / §7.1）。
 *
 * 只做两件事：
 * 1. 从既有报表 response（BalanceSheet / IncomeStatement）派生构成 view-model；
 * 2. 用 `utils/decimal` 的精确 Decimal 完成全部金额判定、排序、Top7 与零容差勾稽。
 *
 * 铁律：
 * - 金额判定/排序/勾稽禁止 Number 浮点；`decToNumber` 只出现在百分比与图表
 *   渲染边界，产生非有限数时降级 contract-blocked（不画 Donut）。
 * - 负向金额不取绝对值入图：作为 offsets 独立披露。
 * - FX 不完整 → fx-blocked：不聚合跨币种、不算百分比、不伪造合计。
 */
import type {
  IncomeStatementSummary,
  PersonalBalanceSheet,
  ReportEnvelope,
  ReportSectionRow,
  WebAccountGroup,
  WebAccountRow,
} from "../api/types";
import {
  decAbs,
  decCompare,
  decCompareDesc,
  decDiff,
  decEquals,
  decSum,
  decToNumber,
  formatDecimal,
  parseDecimal,
  type ScaledDecimal,
} from "./decimal";

// ---------------------------------------------------------------------------
// 共享 view-model（spec §7.1；discriminated union，一次只渲染一个状态）
// ---------------------------------------------------------------------------

/** 筛选状态：空 Set 不能同时表达「全选」与「显式零选」（ED-09）。 */
export type SelectionState =
  | { kind: "all" }
  | { kind: "include"; keys: Set<string> };

export interface CompositionItem {
  key: string;
  label: string;
  amount: ScaledDecimal;
  amountText: string;
  /** 仅渲染用（1 位小数）；不参与排序/门禁。 */
  percentage: number;
  colorIndex: number;
}

export interface CompositionOther {
  amount: ScaledDecimal;
  amountText: string;
  percentage: number;
  children: CompositionItem[];
}

export interface CompositionOffset {
  key: string;
  label: string;
  signedAmount: ScaledDecimal;
  signedAmountText: string;
}

export interface ZeroItem {
  key: string;
  label: string;
  amountText: "0";
}

export interface FxDisclosureRow {
  key: string;
  groupLabel?: string;
  label: string;
  currency: string;
  nativeAmount: string;
  baseAmount: string | null;
}

export interface AmountOnlyRow {
  key: string;
  label: string;
  amountText: string;
  negative: boolean;
}

export type PercentageContext = "total" | "filtered";

export interface CompositionReady {
  status: "ready";
  items: CompositionItem[];
  other: CompositionOther | null;
  zeroItems: ZeroItem[];
  grossText: string;
  netText: string;
  offsets: CompositionOffset[];
  offsetTotalText: string;
  percentageContext: PercentageContext;
}

export interface CompositionOffsetOnly {
  status: "offset-only";
  offsets: CompositionOffset[];
  grossText: "0";
  offsetTotalText: string;
  netText: string;
  percentageContext: PercentageContext;
}

export interface CompositionEmpty {
  status: "empty" | "filtered-empty";
  title: string;
  description: string;
}

export interface CompositionFxBlocked {
  status: "fx-blocked";
  rows: FxDisclosureRow[];
  missingCurrencies: string[];
  subjectLabel: string;
}

export interface CompositionContractBlocked {
  status: "contract-blocked";
  rows: AmountOnlyRow[];
  reason: string;
  controlText?: string;
  derivedText?: string;
  differenceText?: string;
}

export type CompositionModel =
  | CompositionReady
  | CompositionOffsetOnly
  | CompositionEmpty
  | CompositionFxBlocked
  | CompositionContractBlocked;

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const ZERO: ScaledDecimal = { units: 0n, scale: 0 };

function toPercent(part: ScaledDecimal, gross: ScaledDecimal): number | null {
  const grossNum = decToNumber(gross);
  if (!Number.isFinite(grossNum) || grossNum === 0) return null;
  const num = decToNumber(part);
  if (!Number.isFinite(num)) return null;
  return Math.round((num / grossNum) * 1000) / 10;
}

function percentageOrZero(part: ScaledDecimal, gross: ScaledDecimal): number {
  return toPercent(part, gross) ?? 0;
}

/** 渲染边界守卫：任一构成金额无法安全转 number 时不画 Donut（§4.3 rule 5）。 */
function chartNumbersFinite(gross: ScaledDecimal, items: ScaledDecimal[]): boolean {
  if (!Number.isFinite(decToNumber(gross))) return false;
  return items.every((it) => Number.isFinite(decToNumber(it)));
}

/** Top7 + Other（§4.6）：Other = exact gross − exact topSum，永不展开进 Donut。 */
function buildTop7(
  positives: Array<{ key: string; label: string; amount: ScaledDecimal }>,
): {
  items: CompositionItem[];
  other: CompositionOther | null;
} {
  const sorted = [...positives].sort((a, b) => decCompareDesc(a.amount, b.amount));
  const top = sorted.slice(0, 7);
  const rest = sorted.slice(7);
  const gross = decSum(sorted.map((p) => p.amount));

  const items: CompositionItem[] = top.map((p, i) => ({
    key: p.key,
    label: p.label,
    amount: p.amount,
    amountText: formatDecimal(p.amount),
    percentage: percentageOrZero(p.amount, gross),
    colorIndex: i,
  }));
  if (rest.length === 0) return { items, other: null };

  const topTotal = decSum(top.map((p) => p.amount));
  const otherAmount = decDiff(gross, topTotal);
  return {
    items,
    other: {
      amount: otherAmount,
      amountText: formatDecimal(otherAmount),
      percentage: percentageOrZero(otherAmount, gross),
      children: rest.map((p, i) => ({
        key: p.key,
        label: p.label,
        amount: p.amount,
        amountText: formatDecimal(p.amount),
        percentage: percentageOrZero(p.amount, gross),
        colorIndex: top.length + i,
      })),
    },
  };
}

function emptyModel(
  filtered: boolean,
  title: string,
  description: string,
): CompositionEmpty {
  return {
    status: filtered ? "filtered-empty" : "empty",
    title,
    description,
  };
}

function amountOnlyRows(
  positives: Array<{ key: string; label: string; amount: ScaledDecimal }>,
  offsets: CompositionOffset[],
): AmountOnlyRow[] {
  const sorted = [...positives].sort((a, b) => decCompareDesc(a.amount, b.amount));
  return [
    ...sorted.map((p) => ({
      key: p.key, label: p.label, amountText: formatDecimal(p.amount), negative: false,
    })),
    ...offsets.map((o) => ({
      key: o.key, label: o.label, amountText: o.signedAmountText, negative: true,
    })),
  ];
}

function contractBlocked(
  reason: string,
  extras: Partial<CompositionContractBlocked> = {},
): CompositionContractBlocked {
  return { status: "contract-blocked", rows: [], reason, ...extras };
}

// ---------------------------------------------------------------------------
// BalanceSheet adapter（§4.4 / §5.1）
// ---------------------------------------------------------------------------

export interface BalanceCompositionInput {
  data: PersonalBalanceSheet;
  side: "asset" | "liability";
  /** group 下钻 key；null = 顶层。找不到的 key 视为无数据（controller 负责清 URL）。 */
  groupKey?: string | null;
  selection?: SelectionState;
}

interface ScopedLeaf {
  group: WebAccountGroup;
  account: WebAccountRow;
  /** 解析后的 balance_base；非零缺汇率时为 null（FX fail-closed 判定用）。 */
  amount: ScaledDecimal | null;
}

const SUBJECT_ASSET = "资产";
const SUBJECT_LIABILITY = "负债";

export function deriveBalanceSheetComposition(
  input: BalanceCompositionInput,
): CompositionModel {
  const { data, side } = input;
  const groupKey = input.groupKey ?? null;
  const selection = input.selection ?? { kind: "all" };
  const subjectLabel = side === "asset" ? SUBJECT_ASSET : SUBJECT_LIABILITY;

  const sideGroups = data.groups.filter((g) => g.side === side);
  const scopeGroups = groupKey ? sideGroups.filter((g) => g.key === groupKey) : sideGroups;

  // 1) 展开 scope + 筛选 + 金额解析
  const leaves: ScopedLeaf[] = [];
  for (const g of scopeGroups) {
    for (const account of g.accounts) {
      if (selection.kind === "include" && !selection.keys.has(account.id)) continue;

      const native = parseDecimal(account.balance_native);
      if (native === null) {
        return contractBlocked(`账户 ${account.name} 的原币余额不是合法 Decimal：${account.balance_native}`);
      }
      let amount: ScaledDecimal | null;
      if (account.balance_base === null) {
        // 零余额账户 base 允许为 null（不阻断）；非零 null 由 FX 检查处理。
        amount = decEquals(native, ZERO) ? ZERO : null;
      } else {
        amount = parseDecimal(account.balance_base);
        if (amount === null) {
          return contractBlocked(`账户 ${account.name} 的基础币种余额不是合法 Decimal：${account.balance_base}`);
        }
      }
      leaves.push({ group: g, account, amount });
    }
  }

  // 2) 当前比较集合 FX 检查：非零原币余额且无折算 → fail closed（零余额 null 不阻断）
  const blockedLeaves = leaves.filter(
    (l) => l.amount === null && !decEquals(parseDecimal(l.account.balance_native)!, ZERO),
  );
  if (blockedLeaves.length > 0) {
    return {
      status: "fx-blocked",
      rows: blockedLeaves.map((l) => ({
        key: l.account.id,
        groupLabel: l.group.title,
        label: l.account.name,
        currency: l.account.currency,
        nativeAmount: l.account.balance_native,
        baseAmount: l.account.balance_base,
      })),
      missingCurrencies: [...new Set(blockedLeaves.map((l) => l.account.currency))].sort(),
      subjectLabel,
    };
  }

  // 3) 符号分桶（asset：正/零/负；liability：后端正数契约，负值 = contract failure）
  const positives: Array<{ key: string; label: string; amount: ScaledDecimal }> = [];
  const offsets: CompositionOffset[] = [];
  const zeroItems: ZeroItem[] = [];
  for (const leaf of leaves) {
    const amount = leaf.amount as ScaledDecimal;
    const cmp = decCompare(amount, ZERO);
    if (cmp > 0) {
      positives.push(
        groupKey
          ? { key: leaf.account.id, label: leaf.account.name, amount }
          : { key: leaf.group.key, label: leaf.group.title, amount },
      );
    } else if (cmp < 0) {
      if (side === "liability") {
        return {
          ...contractBlocked(
            `负债账户 ${leaf.account.name} 返回负数基础币种余额，违反后端正数展示契约`,
          ),
          rows: [{
            key: leaf.account.id,
            label: leaf.account.name,
            amountText: formatDecimal(amount),
            negative: true,
          }],
        };
      }
      offsets.push({
        key: leaf.account.id,
        label: leaf.account.name,
        signedAmount: amount,
        signedAmountText: formatDecimal(amount),
      });
    } else {
      zeroItems.push({ key: leaf.account.id, label: leaf.account.name, amountText: "0" });
    }
  }

  if (groupKey) {
    // 下钻按 account 粒度聚合后仍需按组去重排序——accounts 已是叶子，直接排序。
    positives.sort((a, b) => decCompareDesc(a.amount, b.amount));
  } else {
    // 顶层：positive accounts 按 group.key 聚合（§4.4 step 4）。
    const byGroup = new Map<string, { key: string; label: string; amount: ScaledDecimal }>();
    for (const p of positives) {
      const existing = byGroup.get(p.key);
      if (existing) {
        existing.amount = decSum([existing.amount, p.amount]);
      } else {
        byGroup.set(p.key, { ...p });
      }
    }
    positives.length = 0;
    positives.push(...[...byGroup.values()].sort((a, b) => decCompareDesc(a.amount, b.amount)));
  }

  // 4) 控制金额与零容差勾稽（§4.4 steps 6–8）
  const gross = decSum(positives.map((p) => p.amount));
  const offsetTotal = decSum(offsets.map((o) => decAbs(o.signedAmount)));
  const scopeNet = decDiff(gross, offsetTotal);
  const filtered = selection.kind === "include";

  if (!filtered) {
    let controlText: string | null;
    if (groupKey) {
      controlText = scopeGroups[0]?.subtotal_base ?? null;
    } else {
      controlText = side === "asset"
        ? data.summary.total_assets_base
        : data.summary.total_liabilities_base;
    }
    const control = controlText === null ? null : parseDecimal(controlText);
    if (control === null) {
      return {
        ...contractBlocked(
          `权威${groupKey ? "分组" : subjectLabel}合计缺失或非法，无法勾稽（${controlText ?? "null"}）`,
        ),
        rows: amountOnlyRows(positives, offsets),
      };
    }
    if (!decEquals(scopeNet, control)) {
      const difference = decDiff(control, scopeNet);
      return {
        status: "contract-blocked",
        rows: amountOnlyRows(positives, offsets),
        reason: `构成明细与权威${groupKey ? "分组小计" : `${subjectLabel}合计`}不一致`,
        controlText: formatDecimal(control),
        derivedText: formatDecimal(scopeNet),
        differenceText: formatDecimal(difference),
      };
    }
  }

  // 5) 状态分流
  const percentageContext: PercentageContext = filtered ? "filtered" : "total";
  const netText = formatDecimal(scopeNet);
  const offsetTotalText = formatDecimal(offsetTotal);
  const hasScopeData = leaves.length > 0;

  if (positives.length === 0) {
    if (offsets.length > 0) {
      return {
        status: "offset-only",
        offsets,
        grossText: "0",
        offsetTotalText,
        netText,
        percentageContext,
      };
    }
    if (!hasScopeData) {
      return emptyModel(
        filtered,
        filtered ? "当前筛选范围没有可用数据" : `暂无${subjectLabel}数据`,
        filtered
          ? "所选账户在当前时点均无数据，请调整筛选条件。"
          : `当前时点没有可展示的${subjectLabel}账户。`,
      );
    }
    // 只选中零余额账户：无正向扇区也不存在冲减，不画 Donut。
    return emptyModel(
      filtered,
      "当前范围没有正向构成",
      "所选账户余额均为零，无构成占比可展示。",
    );
  }

  if (!chartNumbersFinite(gross, positives.map((p) => p.amount))) {
    return {
      ...contractBlocked("构成金额超出可渲染数值范围，已降级为金额列表"),
      rows: amountOnlyRows(positives, offsets),
    };
  }

  const grossText = formatDecimal(gross);
  if (groupKey) {
    // drill：Top7 + Other；zero rows 只进 Ranking 尾部。
    const { items, other } = buildTop7(positives);
    return {
      status: "ready",
      items,
      other,
      zeroItems,
      grossText,
      netText,
      offsets,
      offsetTotalText,
      percentageContext,
    };
  }

  // 顶层：全部非零正 group 展示，不做 Top7；不展示 zero rows。
  return {
    status: "ready",
    items: positives.map((p, i) => ({
      key: p.key,
      label: p.label,
      amount: p.amount,
      amountText: formatDecimal(p.amount),
      percentage: percentageOrZero(p.amount, gross),
      colorIndex: i,
    })),
    other: null,
    zeroItems: [],
    grossText,
    netText,
    offsets,
    offsetTotalText,
    percentageContext,
  };
}

// ---------------------------------------------------------------------------
// IncomeExpense adapter（§4.5 / §5.2）
// ---------------------------------------------------------------------------

export interface IncomeCompositionInput {
  report: ReportEnvelope<IncomeStatementSummary>;
  side: "expense" | "income";
  selection?: SelectionState;
}

const SUBJECT_EXPENSE = "支出";
const SUBJECT_INCOME = "收入";

interface AggregatedLabel {
  label: string;
  amount: ScaledDecimal;
}

function aggregateByLabel(rows: ReportSectionRow[]): AggregatedLabel[] | "contract" {
  const map = new Map<string, ScaledDecimal>();
  for (const row of rows) {
    if (row.amount_base === null) return "contract"; // fx_complete=true 时 null = 契约事故
    const parsed = parseDecimal(row.amount_base);
    if (parsed === null) return "contract";
    const existing = map.get(row.label);
    map.set(row.label, existing ? decSum([existing, parsed]) : parsed);
  }
  return [...map.entries()].map(([label, amount]) => ({ label, amount }));
}

export function deriveIncomeComposition(
  input: IncomeCompositionInput,
): CompositionModel {
  const { report, side } = input;
  const selection = input.selection ?? { kind: "all" };
  const subjectLabel = side === "expense" ? SUBJECT_EXPENSE : SUBJECT_INCOME;

  // 1) management 口径守卫
  if (report.accounting_view === "native") {
    return contractBlocked("当前报表为 native 口径，构成分析仅支持 management 口径");
  }

  const sectionKey = side === "expense" ? "expenses" : "income";
  const section = report.sections.find((s) => s.key === sectionKey);
  const rows = section?.rows ?? [];

  // 2) FX fail closed：立即阻断，不做跨币种 sum、不算百分比
  if (report.fx_complete === false) {
    const byCurrency = new Map<string, ReportSectionRow[]>();
    for (const row of rows) {
      const list = byCurrency.get(row.currency) ?? [];
      list.push(row);
      byCurrency.set(row.currency, list);
    }
    const disclosed: FxDisclosureRow[] = [];
    for (const [currency, list] of [...byCurrency.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      list
        .sort((a, b) => {
          const pa = parseDecimal(a.amount);
          const pb = parseDecimal(b.amount);
          if (pa === null || pb === null) return a.label.localeCompare(b.label);
          return decCompareDesc(decAbs(pa), decAbs(pb));
        })
        .forEach((row, i) => {
          disclosed.push({
            key: `${row.label}:${currency}:${i}`,
            label: row.label,
            currency,
            nativeAmount: row.amount,
            baseAmount: row.amount_base,
          });
        });
    }
    return {
      status: "fx-blocked",
      rows: disclosed,
      missingCurrencies: report.summary.missing_currencies ?? [],
      subjectLabel,
    };
  }

  // 3) 全量（未筛选）聚合 + 零容差控制：全量失败时任何 filter subset 都不得画 Donut
  const fullAgg = aggregateByLabel(rows);
  if (fullAgg === "contract") {
    return contractBlocked("报表行包含缺失或非法的基础币种金额，无法构成分析");
  }
  const fullPositive = fullAgg.filter((a) => decCompare(a.amount, ZERO) > 0);
  const fullNegative = fullAgg.filter((a) => decCompare(a.amount, ZERO) < 0);
  const fullGross = decSum(fullPositive.map((a) => a.amount));
  const fullOffsets = decSum(fullNegative.map((a) => decAbs(a.amount)));
  const fullNet = decDiff(fullGross, fullOffsets);

  const controlText = side === "expense"
    ? report.summary.total_expenses_cny
    : report.summary.total_income_cny;
  const control = controlText === null || controlText === undefined ? null : parseDecimal(controlText);
  if (control === null) {
    return {
      ...contractBlocked(`权威${subjectLabel}合计缺失或非法，无法勾稽`),
      rows: amountOnlyRows(
        fullPositive.map((a) => ({ ...a, key: a.label })),
        fullNegative.map((a) => ({
          key: a.label,
          label: a.label,
          signedAmount: a.amount,
          signedAmountText: formatDecimal(a.amount),
        })),
      ),
    };
  }
  if (!decEquals(fullNet, control)) {
    const difference = decDiff(control, fullNet);
    return {
      status: "contract-blocked",
      rows: amountOnlyRows(
        fullPositive.map((a) => ({ ...a, key: a.label })),
        fullNegative.map((a) => ({
          key: a.label,
          label: a.label,
          signedAmount: a.amount,
          signedAmountText: formatDecimal(a.amount),
        })),
      ),
      reason: `构成明细与权威${subjectLabel}合计不一致`,
      controlText: formatDecimal(control),
      derivedText: formatDecimal(fullNet),
      differenceText: formatDecimal(difference),
    };
  }

  // 4) 应用 category 筛选（同 label 的所有 currency rows 同时纳入或排除）
  const filtered = selection.kind === "include";
  const scopeAgg = filtered
    ? fullAgg.filter((a) => selection.keys.has(a.label))
    : fullAgg;

  const positives: Array<{ key: string; label: string; amount: ScaledDecimal }> = [];
  const offsets: CompositionOffset[] = [];
  for (const agg of scopeAgg) {
    const cmp = decCompare(agg.amount, ZERO);
    if (cmp > 0) positives.push({ key: agg.label, label: agg.label, amount: agg.amount });
    else if (cmp < 0) {
      offsets.push({
        key: agg.label,
        label: agg.label,
        signedAmount: agg.amount,
        signedAmountText: formatDecimal(agg.amount),
      });
    }
    // 零净额 label 不进图（§4.5 step 5）
  }

  // 5) 状态分流
  const percentageContext: PercentageContext = filtered ? "filtered" : "total";
  const gross = decSum(positives.map((p) => p.amount));
  const offsetTotal = decSum(offsets.map((o) => decAbs(o.signedAmount)));
  const net = decDiff(gross, offsetTotal);

  if (positives.length === 0) {
    if (offsets.length > 0) {
      return {
        status: "offset-only",
        offsets,
        grossText: "0",
        offsetTotalText: formatDecimal(offsetTotal),
        netText: formatDecimal(net),
        percentageContext,
      };
    }
    return emptyModel(
      filtered,
      filtered ? "当前筛选范围没有可用数据" : `本期无${subjectLabel}记录`,
      filtered
        ? "所选分类在本期间没有数据，请调整筛选条件。"
        : `本期间没有${subjectLabel}分类记录。`,
    );
  }

  if (!chartNumbersFinite(gross, positives.map((p) => p.amount))) {
    return {
      ...contractBlocked("构成金额超出可渲染数值范围，已降级为金额列表"),
      rows: amountOnlyRows(positives, offsets),
    };
  }

  const { items, other } = buildTop7(positives);
  return {
    status: "ready",
    items,
    other,
    zeroItems: [],
    grossText: formatDecimal(gross),
    netText: formatDecimal(net),
    offsets,
    offsetTotalText: formatDecimal(offsetTotal),
    percentageContext,
  };
}
