import { NavLink } from "react-router-dom";
import { ArrowUpRight, TriangleAlert } from "lucide-react";
import { Amount, SignedAmount } from "../../components/Amount";
import { pctChange } from "../../utils/trends";

/**
 * 首页 Block 1（home 专用，替代共享 HeadlineBlock 的呈现）：
 * 焦点明确的大字净资产 + 克制语义变动；下方三格副指标以发丝线分隔。
 * 保留：上月环比、待处理异常 affordance、FX 缺失披露（testid 锚点）。
 */
export function HomeHero({
  netWorth,
  totalAssets,
  totalLiabilities,
  availableCash,
  availableCashUnknown,
  currency,
  prevNetWorth,
  fxComplete = true,
  missingCurrencies = [],
  pendingAnomalyCount,
}: {
  netWorth: string | null;
  totalAssets: string | null;
  totalLiabilities: string | null;
  availableCash: string | null;
  availableCashUnknown: boolean;
  currency: string;
  prevNetWorth: string | null;
  fxComplete?: boolean;
  missingCurrencies?: string[];
  pendingAnomalyCount: number;
}) {
  const delta = pctChange(netWorth, prevNetWorth);
  const deltaNum = delta === null ? null : Number(delta.replace("+", ""));
  const deltaTone =
    deltaNum === null
      ? "neutral"
      : deltaNum > 0
        ? "positive"
        : deltaNum < 0
          ? "negative"
          : "neutral";

  const fxNoteText = missingCurrencies.length
    ? `缺少 ${missingCurrencies.join("、")} 汇率，相关金额未计入`
    : "缺少汇率，相关金额未计入";

  return (
    <section aria-label="净资产概览" className="headline-block flex flex-col gap-4">
      <div
        className="flex flex-col gap-3 rounded-[var(--radius-hero)] px-6 py-5 text-white max-sm:px-5"
        style={{ backgroundImage: "var(--hero-bg)" }}
      >
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-medium tracking-wide text-white/75">
            净资产
          </span>
          {pendingAnomalyCount >= 1 && (
            <NavLink
              to="/alerts"
              className="headline-alert-affordance inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-white/25"
              aria-label={`有 ${pendingAnomalyCount} 个待处理异常，点击查看`}
            >
              <TriangleAlert size={11} aria-hidden="true" />
              {pendingAnomalyCount} 个待处理
            </NavLink>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <span className="headline-sentence text-[44px] max-[359px]:text-[36px] font-semibold leading-none tracking-[-0.025em] text-white tabular-nums sm:text-[52px]">
            <SignedAmount value={netWorth} currency={currency} />
          </span>
          <span className="hero-delta mb-1 inline-flex items-center gap-0.5 text-[14px] font-medium tabular-nums text-white/85">
            {deltaTone !== "neutral" && <ArrowUpRight size={14} aria-hidden="true"
              className={deltaTone === "negative" ? "rotate-90" : ""} />}
            {delta === null ? "较上月 —" : `较上月 ${delta}`}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
        <HeroStat label="总资产">
          <Amount value={totalAssets} currency={currency} />
        </HeroStat>
        <HeroStat label="总负债">
          <Amount value={totalLiabilities} currency={currency} />
        </HeroStat>
        <HeroStat label="可用现金">
          {availableCashUnknown ? (
            <span className="text-[var(--delta-neutral)]" title="账户数据不可用">
              未知
            </span>
          ) : (
            <Amount value={availableCash} currency={currency} />
          )}
        </HeroStat>
      </div>

      {fxComplete === false && (
        <p
          data-testid="headline-fx-note"
          className="m-0 text-[12.5px] leading-5 text-[var(--delta-warning)]"
        >
          {fxNoteText}
        </p>
      )}
    </section>
  );
}

function HeroStat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="headline-secondary headline-secondary-item flex flex-col gap-1.5 rounded-xl border border-solid border-[var(--border-soft)] bg-[var(--card)] px-4 py-3.5">
      <span className="headline-secondary-label text-[13px] leading-[20px] text-[var(--text-faint)]">
        {label}
      </span>
      <span className="headline-secondary-value text-[20px] font-bold leading-[26px] text-[var(--text-body)] tabular-nums">
        {children}
      </span>
    </div>
  );
}
