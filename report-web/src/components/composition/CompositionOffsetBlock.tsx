import { Amount, SignedAmount } from "../Amount";
import type { CompositionOffset } from "../../utils/compositionSeries";

/**
 * 冲减项披露块（spec §7.6）：负向 rows、offset total 与勾稽公式。
 * - neutral subtle 卡片（禁止 danger/warning 红黄横幅）；
 * - 公式 `gross − abs(offsets) = net` 使用真实 DOM + tabular numbers；
 * - light 背景 --surface-raised，dark 由该 token 的暗色档给出（§2.5 #3）；
 * - offsets 为空时不渲染。
 */
export interface CompositionOffsetBlockProps {
  title: string; // 冲减项（负余额 / 退款 / 收入冲回）
  offsets: CompositionOffset[];
  grossText: string;
  offsetTotalText: string;
  netText: string;
  grossLabel: string;
  netLabel: string;
  currency: string;
}

export function CompositionOffsetBlock({
  title,
  offsets,
  grossText,
  offsetTotalText,
  netText,
  grossLabel,
  netLabel,
  currency,
}: CompositionOffsetBlockProps) {
  if (offsets.length === 0) return null;
  return (
    <div className="comp-offset bg-[var(--surface-raised)] border border-solid border-[var(--border-emphasis)] rounded-xl py-[var(--space-3)] px-[var(--space-4)] flex flex-col gap-[var(--space-2)] [[data-theme='dark']_&]:bg-[var(--surface-raised)]">
      <div className="[font:var(--type-body)] font-semibold text-[var(--text-body)]">{title}</div>
      <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
        {offsets.map((offset) => (
          <li key={offset.key} className="comp-offset-row flex items-center justify-between gap-[var(--space-3)] min-h-8">
            <span className="overflow-hidden [text-overflow:ellipsis] whitespace-nowrap text-[var(--text-muted)]" title={offset.label}>{offset.label}</span>
            <span className="comp-offset-amount">
              <SignedAmount value={offset.signedAmountText} currency={currency} />
            </span>
          </li>
        ))}
      </ul>
      <div className="comp-offset-formula flex items-center flex-wrap gap-[var(--space-2)] pt-[var(--space-2)] border-t border-t-[var(--neutral-300,_#C6CDD5)] [font-variant-numeric:tabular-nums]">
        <span className="inline-flex items-baseline gap-[var(--space-1)]">
          <span className="text-[var(--text-faint)] [font:var(--type-caption)]">{grossLabel}</span>
          <Amount value={grossText} currency={currency} />
        </span>
        <span className="text-[var(--text-faint)] py-0 px-0.5" aria-hidden="true">−</span>
        <span className="inline-flex items-baseline gap-[var(--space-1)]">
          <span className="text-[var(--text-faint)] [font:var(--type-caption)]">冲减</span>
          <Amount value={offsetTotalText} currency={currency} />
        </span>
        <span className="text-[var(--text-faint)] py-0 px-0.5" aria-hidden="true">=</span>
        <span className="inline-flex items-baseline gap-[var(--space-1)]">
          <span className="text-[var(--text-faint)] [font:var(--type-caption)]">{netLabel}</span>
          <SignedAmount value={netText} currency={currency} />
        </span>
      </div>
    </div>
  );
}
