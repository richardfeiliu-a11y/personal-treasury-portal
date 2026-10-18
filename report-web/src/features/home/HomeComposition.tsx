import { EChart } from "../../components/Chart";
import { useMask } from "../../components/MaskContext";
import { formatNumber } from "../../utils/format";
import type { WebAccountGroup } from "../../api/types";
import {
  HOME_GREENS,
  homeCompositionDonutOption,
  type HomeDonutSlice,
} from "./homeChartOptions";

const PENDING_COLOR = "#E3E7EA";

/**
 * 首页 Block 6（home 专用）：资产组合品牌绿环（替代共享 100% 段条）。
 * 绿的明度阶梯，缺折算部分以中性「汇率待定」补齐成整环；中心叠加大字总额（DOM）。
 */
export function HomeComposition({
  groups,
  total,
  baseCurrency,
}: {
  groups: WebAccountGroup[];
  total: string | null;
  baseCurrency: string;
}) {
  const { masked } = useMask();

  const totalNum = total !== null ? Number(total) : null;
  const assetGroups = groups.filter(
    (g) => g.side === "asset" && g.subtotal_base !== null && Number(g.subtotal_base) > 0,
  );

  if (totalNum === null || totalNum <= 0) {
    return (
      <section aria-label="资产组合分布" className="composition-segment-bar flex flex-col gap-1">
        <span className="text-[14px] font-semibold text-[var(--foreground)]">
          资产组合分布
        </span>
        <p className="m-0 py-3 text-center text-[13px] text-[var(--delta-neutral)]">
          暂无资产数据
        </p>
      </section>
    );
  }

  const slices: HomeDonutSlice[] = assetGroups.map((g, i) => ({
    key: g.key,
    label: g.title,
    amountText: g.subtotal_base ?? "0",
    value: Number(g.subtotal_base),
    color: HOME_GREENS[i % HOME_GREENS.length],
  }));

  const known = slices.reduce((s, x) => s + x.value, 0);
  const pending = Math.max(0, totalNum - known);
  if (pending > 0.01) {
    slices.push({
      key: "fx_pending",
      label: "汇率待定",
      amountText: pending.toFixed(2),
      value: pending,
      color: PENDING_COLOR,
    });
  }

  const option = homeCompositionDonutOption(slices, {
    masked,
    currency: baseCurrency,
  });

  return (
    <section aria-label="资产组合分布" className="composition-segment-bar flex flex-col gap-5">
      <div className="flex w-full max-w-[600px] flex-col items-center gap-6 sm:flex-row sm:items-center">
        <div className="relative h-[190px] w-[190px] shrink-0">
          <EChart
            option={option}
            height={190}
            ariaLabel="资产组合品牌绿环形图"
          />
          <div className="comp-donut-center pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-[var(--card)] rounded-full [background-image:none] [margin:auto] h-[134px] w-[134px]">
            <span className="comp-donut-center text-[10px] text-[var(--delta-neutral)]">资产合计</span>
            <span className="comp-donut-center text-[15px] font-semibold leading-5 text-[var(--foreground)] tabular-nums">
              {masked
                ? "••••"
                : formatNumber(total).replace(/\.\d{2}$/, "")}
              <span className="absolute w-px h-px m-[-1px] p-0 overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap border-0">{baseCurrency}</span>
            </span>
          </div>
        </div>

        <ul className="m-0 w-fit list-none p-0">
          {slices.map((s) => {
            const pct = ((s.value / totalNum) * 100).toFixed(1);
            return (
              <li
                key={s.key}
                className="flex items-center gap-3 py-[7px]"
              >
                <span className="flex min-w-0 flex-1 items-center gap-2.5 text-[13px] text-[var(--foreground)]">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                    style={{ background: s.color }}
                  />
                  <span className="truncate">{s.label}</span>
                </span>
                <span className="shrink-0 text-[13px] font-semibold tabular-nums text-[var(--foreground)]">
                  {pct}%
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
