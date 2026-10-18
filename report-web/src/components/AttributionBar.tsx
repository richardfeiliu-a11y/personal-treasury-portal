import { formatNumber } from '../utils/format';
import { useMask } from './MaskContext';

/**
 * Block 4 — AttributionBar (Spec §7.4)
 * fx-attribution 的 savings vs FX 堆叠段, FX pending 灰段
 * 数据来源：GET /api/reports/web/fx-attribution
 */
export function AttributionBar({
  savingsContribution, fxContribution, totalChange, currency,
}: {
  savingsContribution: string | null;
  fxContribution: string | null;
  totalChange: string | null;
  currency: string;
}) {
  const { masked } = useMask();
  const savings = savingsContribution !== null ? Number(savingsContribution) : 0;
  const fx = fxContribution !== null ? Number(fxContribution) : 0;
  const total = Math.abs(savings) + Math.abs(fx);

  if (total === 0) {
    return (
      <section className='attribution-bar' aria-label='本月变动归因'>
        <div className='attribution-bar-header'>
          <span className='attribution-bar-title'>本月变动归因</span>
        </div>
        <p className='attribution-bar-empty'>暂无归因数据</p>
      </section>
    );
  }

  const savingsPct = (Math.abs(savings) / total) * 100;
  const fxPct = (Math.abs(fx) / total) * 100;
  const fmt = (v: number) => masked ? '\u2022\u2022\u2022\u2022' : formatNumber(v);

  const showSegmentLabel = (pct: number) => pct >= 8;

  return (
    <section className='attribution-bar' aria-label='本月变动归因'>
      <div className='attribution-bar-header'>
        <span className='attribution-bar-title'>本月变动归因</span>
        <span className='attribution-bar-total' title={totalChange !== null ? `本月变动: ${fmt(Number(totalChange))} ${currency}` : undefined}>
          {totalChange !== null ? `${fmt(Number(totalChange))} ${currency}` : '—'}
        </span>
      </div>
      <div className='attribution-bar-track'>
        <div className='attribution-segment attribution-savings' style={{ width: `${savingsPct}%` }} title={`储蓄贡献: ${fmt(savings)} ${currency}`}>
          {showSegmentLabel(savingsPct) && <span className='attribution-segment-label'>{fmt(savings)} {currency}</span>}
        </div>
        <div className='attribution-segment attribution-fx' style={{ width: `${fxPct}%` }} title={`汇率贡献: ${fmt(fx)} ${currency}`}>
          {showSegmentLabel(fxPct) && <span className='attribution-segment-label'>{fmt(fx)} {currency}</span>}
        </div>
      </div>
      <div className='attribution-bar-legend'>
        <span className='attribution-legend-item'><span className='attribution-dot attribution-dot-savings' /> 储蓄贡献</span>
        <span className='attribution-legend-item'><span className='attribution-dot attribution-dot-fx' /> 汇率贡献</span>
      </div>
    </section>
  );
}
