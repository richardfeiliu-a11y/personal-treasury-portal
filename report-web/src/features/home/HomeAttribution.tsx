import { formatNumber } from "../../utils/format";
import { useMask } from "../../components/MaskContext";

/**
 * 首页 Block 5（home 专用）：本月变动归因。
 * 储蓄贡献 = 品牌绿；汇率贡献不再用孤立纯蓝，改为克制金色点缀。
 * 保留测试锚点：.attribution-fx[title]、.attribution-segment-label、
 * .attribution-bar-total、「储蓄贡献 / 汇率贡献」图例文案。
 */
export function HomeAttribution({
  savingsContribution,
  fxContribution,
  totalChange,
  currency,
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
  const fmt = (v: number) => (masked ? "••••" : formatNumber(v));

  if (total === 0) {
    return (
      <section className="attribution-bar bg-[var(--card)] border border-solid border-[var(--border-soft)] rounded-xl py-4 px-5" aria-label="本月变动归因">
        <span className="text-[14px] font-semibold text-[var(--foreground)]">
          本月变动归因
        </span>
        <p className="text-[13px] text-[var(--text-faint)] mt-2 mx-0 mb-0">暂无归因数据</p>
      </section>
    );
  }

  const savingsPct = (Math.abs(savings) / total) * 100;
  const fxPct = (Math.abs(fx) / total) * 100;

  return (
    <section className="attribution-bar bg-[var(--card)] border border-solid border-[var(--border-soft)] rounded-xl py-4 px-5" aria-label="本月变动归因">
      <div className="flex justify-between items-center mb-3">
        <span className="text-[14px] font-semibold text-[var(--text-muted)]">本月变动归因</span>
        <span
          className="tabular-nums text-[14px] font-semibold text-[var(--text-body)]"
          title={
            totalChange !== null
              ? `本月变动: ${fmt(Number(totalChange))} ${currency}`
              : undefined
          }
        >
          {totalChange !== null
            ? `${fmt(Number(totalChange))} ${currency}`
            : "—"}
        </span>
      </div>

      {/* 数值只出现在右上角总额和图例里。窄段（<8%）在条上看不见，
          用一个无数字的标记保证它仍可被定位；宽段不再放金额。 */}
      <div className="relative !h-[10px] !rounded-full flex overflow-hidden bg-[var(--surface-subtle)]">
        <div
          className="attribution-segment attribution-savings [transition:width_0.3s] min-w-0"
          style={{ width: `${savingsPct}%`, background: "#157A5A", minWidth: savingsPct > 0 && savingsPct < 8 ? 6 : undefined }}
          title={`储蓄贡献: ${fmt(savings)} ${currency}`}
        />
        <div
          className="attribution-segment attribution-fx [transition:width_0.3s] min-w-0"
          style={{ width: `${fxPct}%`, background: "#C9A24B", minWidth: fxPct > 0 && fxPct < 8 ? 6 : undefined }}
          title={`汇率贡献: ${fmt(fx)} ${currency}`}
        />
        {savingsPct > 0 && savingsPct < 8 && (
          <span className="attribution-segment-label absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-white" style={{ left: `calc(${savingsPct}% / 2)` }} />
        )}
        {fxPct > 0 && fxPct < 8 && (
          <span className="attribution-segment-label absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-white" style={{ right: `calc(${fxPct}% / 2)` }} />
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        <span className="inline-flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)]">
          <span className="h-2 w-2 rounded-full" style={{ background: "#157A5A" }} />
          储蓄贡献
          <span className="font-semibold text-[var(--foreground)] tabular-nums">
            {savingsPct.toFixed(1)}%
          </span>
        </span>
        <span className="inline-flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)]">
          <span className="h-2 w-2 rounded-full" style={{ background: "#C9A24B" }} />
          汇率贡献
          <span className="font-semibold text-[var(--foreground)] tabular-nums">
            {fxPct.toFixed(1)}%
          </span>
        </span>
      </div>
    </section>
  );
}
