import { formatNumber } from '../utils/format';
import { useMask } from './MaskContext';
import type { WebAccountGroup } from '../api/types';

/**
 * CompositionSegmentBar (Spec §7.6/§8.2, C6)
 * 100% 闭合段，缺 FX 灰段 FX pending (xx.x%)。
 * （asset/liability 双侧参数与负债分支已随 BalanceSheetCompositionCard
 * 取代负债侧展示而消融，A14。）
 */
const SEGMENT_COLORS = ['var(--chart-primary-green)', 'var(--chart-investment)', 'var(--chart-blue)', 'var(--chart-purple)', 'var(--chart-muted-teal)', 'var(--chart-grey)'];

export function CompositionSegmentBar({
  groups,
  total,
  baseCurrency,
}: {
  groups: WebAccountGroup[];
  total?: string | null;
  baseCurrency: string;
}) {
  const { masked } = useMask();

  const sideGroups = groups.filter(
    (g) => g.side === 'asset' && g.subtotal_base !== null && Number(g.subtotal_base) > 0,
  );
  const totalNum = total !== null && total !== undefined ? Number(total) : null;
  const label = '资产组合分布';
  const colors = SEGMENT_COLORS;

  if (totalNum === null || totalNum <= 0) {
    return (
      <section className="bg-[var(--card)] border border-solid border-[var(--border-soft)] rounded-xl py-4 px-5" aria-label={label}>
        <div className="flex justify-between items-center mb-3">
          <span className="text-[14px] font-semibold text-[var(--text-muted)]">{label}</span>
        </div>
        <p className="text-[13px] text-[var(--text-faint)] mt-2 mx-0 mb-0">暂无资产数据</p>
      </section>
    );
  }

  const segments = sideGroups.map((g) => {
    const val = Number(g.subtotal_base);
    return { title: g.title, value: val, pct: (val / totalNum) * 100 };
  });

  const knownPct = segments.reduce((s, seg) => s + seg.pct, 0);
  const fxPendingPct = Math.max(0, 100 - knownPct);

  const fmt = (v: number) => masked ? '\u2022\u2022\u2022\u2022' : formatNumber(v);

  return (
    <section className="bg-[var(--card)] border border-solid border-[var(--border-soft)] rounded-xl py-4 px-5" aria-label={label}>
      <div className="flex justify-between items-center mb-3">
        <span className="text-[14px] font-semibold text-[var(--text-muted)]">{label}</span>
        <span className="text-[13px] text-[var(--text-faint)]">{baseCurrency}</span>
      </div>
      <div className="flex h-6 rounded-[6px] overflow-hidden bg-[var(--surface-subtle)]">
        {segments.map((seg, i) => (
          <div
            key={seg.title}
            className="flex items-center justify-center [transition:width_0.3s] min-w-0 overflow-hidden"
            style={{ width: `${seg.pct}%`, backgroundColor: colors[i % colors.length] }}
            title={`${seg.title}: ${fmt(seg.value)} ${baseCurrency} (${seg.pct.toFixed(1)}%)`}
          >
            {seg.pct >= 8 && <span className="text-[10px] font-semibold text-[#000] whitespace-nowrap [.composition-segment-fx-pending_&]:text-[var(--text-muted)] [[data-theme='dark']_.composition-segment-fx-pending_&]:text-[var(--text-inverse)]">{seg.pct.toFixed(1)}%</span>}
          </div>
        ))}
        {fxPendingPct > 0.1 && (
          <div
            className="composition-segment-fx-pending flex items-center justify-center [transition:width_0.3s] min-w-0 overflow-hidden bg-[var(--data-neutral-strong)]"
            style={{ width: `${fxPendingPct}%` }}
            title={`汇率待定 (${fxPendingPct.toFixed(1)}%)`}
          >
            {fxPendingPct >= 8 && <span className="text-[10px] font-semibold text-[#000] whitespace-nowrap [.composition-segment-fx-pending_&]:text-[var(--text-muted)] [[data-theme='dark']_.composition-segment-fx-pending_&]:text-[var(--text-inverse)]">汇率待定 ({fxPendingPct.toFixed(1)}%)</span>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-3 mt-2">
        {segments.map((seg, i) => (
          <span key={seg.title} className="flex items-center gap-1.5 text-[12px] text-[var(--text-subtle)]">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: colors[i % colors.length] }} />
            {seg.title} {seg.pct.toFixed(1)}%
          </span>
        ))}
        {fxPendingPct > 0.1 && (
          <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-subtle)]">
            <span className="w-2 h-2 rounded-full bg-[var(--data-neutral-strong)]" />
            汇率待定 ({fxPendingPct.toFixed(1)}%)
          </span>
        )}
      </div>
    </section>
  );
}
