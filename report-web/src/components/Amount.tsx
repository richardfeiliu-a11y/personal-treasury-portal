import { useMask } from "./MaskContext";
import { formatAmount, formatSigned, maskAmount } from "../utils/format";

function AmountText({ text, currency }: { text: string; currency: string }) {
  const number = text.slice(0, -(currency.length + 1));
  return (
    <span className="amount inline-flex items-baseline gap-1.5 whitespace-nowrap font-[var(--font-family-mono)] [font-variant-numeric:tabular-nums] [font-feature-settings:'tnum'_1] [.transaction-card-value_&]:whitespace-normal [.comp-donut-center_&]:font-semibold">
      <span className="amount-number">{number}</span>
      <span className="amount-currency text-[var(--text-subtle)] text-[12px] font-medium tracking-[0.02em] [.hero-value_&]:text-[0.45em] [.hero-value_&]:text-[rgba(255,_255,_255,_0.75)] [.hero-value_&]:ml-1.5 [.hero-footer_&]:text-[rgba(255,_255,_255,_0.75)] [.metric-card-value_&]:text-[12px] [.kpi-card-value_&]:text-[12px]" aria-hidden="true">{currency}</span>
      <span className="sr-only">{currency}</span>
    </span>
  );
}

/** 金额缺失（汇率缺失）时渲染的统一提示。金融语义：null 绝不当作 0。 */
function MissingAmount() {
  return (
    <span className="amount amount-missing inline-flex items-baseline gap-1.5 whitespace-nowrap font-[var(--font-family-mono)] [font-variant-numeric:tabular-nums] [font-feature-settings:'tnum'_1] [.transaction-card-value_&]:whitespace-normal [.comp-donut-center_&]:font-semibold text-[var(--danger-600)]" title="汇率缺失，无法折算">
      汇率缺失
    </span>
  );
}

interface AmountCoreProps {
  value: string | null | undefined;
  currency: string;
  signed: boolean;
}

/**
 * Amount / SignedAmount 的共享实现。
 * - null/undefined → 汇率缺失提示（永不渲染 "0"）；
 * - 遮蔽时只隐藏数字、保留币种。
 */
function AmountCore({ value, currency, signed }: AmountCoreProps) {
  const { masked } = useMask();
  if (value === null || value === undefined) {
    return <MissingAmount />;
  }
  const text = signed ? formatSigned(value, currency) : formatAmount(value, currency);
  const visibleText = masked ? maskAmount(text) : text;
  return <AmountText text={visibleText} currency={currency} />;
}

/** 金额组件：遮蔽时只隐藏数字、保留币种；null 表示汇率缺失。 */
export function Amount({ value, currency }: { value: string | null | undefined; currency: string }) {
  return <AmountCore value={value} currency={currency} signed={false} />;
}

/** 带正负号金额（净资产等）。 */
export function SignedAmount({ value, currency }: { value: string | null | undefined; currency: string }) {
  return <AmountCore value={value} currency={currency} signed />;
}
