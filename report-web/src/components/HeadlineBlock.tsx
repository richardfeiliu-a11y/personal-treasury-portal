import { NavLink } from 'react-router-dom';
import { TriangleAlert } from 'lucide-react';
import { SignedAmount, Amount } from './Amount';
import { pctChange } from '../utils/trends';
import { useAnomalies } from '../api/hooks';
import { countUndismissedAnomalies } from '../utils/anomalyFilters';
import { getDismissals } from '../utils/snooze';

/**
 * Block 1 — HeadlineBlock (Spec §7.1, v1.2 §5-bis.5)
 * 一句话净资产陈述 + 副指标行（总资产/总负债/可用现金，各带 delta，零值灰）
 * 当未关闭异常 N ≥ 1 时，在右侧渲染低调的 alert affordance
 *
 * UX-01：`fxComplete === false` 时追加缺失汇率副文案——首页金额显示「汇率缺失/—」
 * 过去无解释，用户无法区分「真的没有」与「折算不出来」。数据沿用 useBalanceSheet
 * 的 `fx_complete` + `missing_currencies`（与资产负债页同源），不由前端推断。
 */
export function HeadlineBlock({
  netWorth, totalAssets, totalLiabilities, availableCash, availableCashUnknown, currency,
  prevNetWorth, fxComplete = true, missingCurrencies = [],
}: {
  netWorth: string | null;
  totalAssets: string | null;
  totalLiabilities: string | null;
  availableCash: string | null;
  /** WP06：账户数据不可用 → 显示「未知」，不与汇率缺失/真实零混淆。 */
  availableCashUnknown?: boolean;
  currency: string;
  prevNetWorth?: string | null;
  /** 后端折算完整性旗标；缺省视为完整（旧调用不新增披露）。 */
  fxComplete?: boolean;
  /** 缺失汇率的币种清单，仅在 fxComplete=false 时使用。 */
  missingCurrencies?: string[];
}) {
  const anomaliesQ = useAnomalies();
  const count = countUndismissedAnomalies(
    anomaliesQ.data?.anomalies ?? [],
    getDismissals(),
  );

  const nwDelta = prevNetWorth !== undefined ? pctChange(netWorth, prevNetWorth) : null;

  /** 副文案：币种清单为空时只说「缺少汇率」，不臆造币种代码。 */
  const fxNoteText = missingCurrencies.length
    ? `缺少 ${missingCurrencies.join("、")} 汇率，相关金额未计入`
    : "缺少汇率，相关金额未计入";

  function DeltaPill({ delta, direction }: { delta: string | null; direction: 'higher-is-better' | 'lower-is-better' }) {
    if (delta === null) return null;
    const num = Number(delta.replace('%', '').replace('+', ''));
    const favorable = direction === 'higher-is-better' ? num > 0 : num < 0;
    const cls = favorable
      ? 'text-[var(--success-700)]'
      : num === 0
        ? 'text-[var(--text-faint)]'
        : 'text-[var(--danger-600)]';
    return <span className={cls}>{delta}</span>;
  }

  return (
    <section className='headline-block' aria-label='净资产概览'>
      <p className='headline-sentence'>
        净资产 <SignedAmount value={netWorth} currency={currency} />，
        {nwDelta !== null ? (
          <>较上月 <DeltaPill delta={nwDelta} direction='higher-is-better' /></>
        ) : (
          <span className='text-[var(--text-faint)]'>较上月 —</span>
        )}
        {count >= 1 && (
          <NavLink
            to="/alerts"
            className="headline-alert-affordance inline-flex items-center gap-1.5 ml-3 py-1 px-2 rounded-[8px] no-underline text-[var(--text-muted)] [font:var(--type-caption)] [transition:background_var(--duration-hover)_var(--ease-standard)] hover:bg-[var(--surface-subtle)] hover:text-[var(--primary)]"
            aria-label={`有 ${count} 个待处理异常，点击查看`}
          >
            <TriangleAlert size={14} aria-hidden="true" className="headline-alert-icon" />
            <span>{count} 个待处理</span>
          </NavLink>
        )}
      </p>
      <div className='headline-secondary'>
        <div className='headline-secondary-item'>
          <span className='headline-secondary-label'>总资产</span>
          <span className='headline-secondary-value'>
            <Amount value={totalAssets} currency={currency} />
          </span>
        </div>
        <div className='headline-secondary-item'>
          <span className='headline-secondary-label'>总负债</span>
          <span className='headline-secondary-value'>
            <Amount value={totalLiabilities} currency={currency} />
          </span>
        </div>
        <div className='headline-secondary-item'>
          <span className='headline-secondary-label'>可用现金</span>
          <span className='headline-secondary-value'>
            {availableCashUnknown
              ? <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap font-[var(--font-family-mono)] [font-variant-numeric:tabular-nums] text-[var(--danger-600)]" title="账户数据不可用">未知</span>
              : <Amount value={availableCash} currency={currency} />}
          </span>
        </div>
      </div>
      {/* UX-01：折算不完整时解释「为什么金额缺失」——只披露后端给的币种清单 */}
      {fxComplete === false && (
        <p className="mt-2 mx-0 mb-0 text-[13px] leading-[20px] font-normal text-[var(--warning-800)]" data-testid="headline-fx-note">{fxNoteText}</p>
      )}
    </section>
  );
}
