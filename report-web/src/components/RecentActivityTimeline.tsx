import { Amount } from './Amount';
import type { TransactionRow } from '../api/types';

/**
 * Block 7b — RecentActivityTimeline (Spec §7.8)
 * Recent activity timeline (significant events only)
 */
export function RecentActivityTimeline({
  transactions, baseCurrency,
}: {
  transactions: TransactionRow[];
  baseCurrency: string;
}) {
  // 过滤显著交易（折算金额 > 1000 或标记为显著）。
  // 缺汇率行 amount_base=null：折算阈值无法评估，仅凭 significant 标签入选
  // （金额不过滤，避免把缺失当作 0 与「缺失≠折算」铁律冲突）。
  const significant = transactions
    .filter((t) =>
      (t.amount_base !== null && Math.abs(Number(t.amount_base)) > 1000) ||
      t.tags.includes('significant'),
    )
    .slice(0, 5);

  if (significant.length === 0) {
    return (
      <section className='recent-activity-timeline' aria-label='近期活动'>
        <div className='recent-activity-header'>
          <span className='recent-activity-title'>近期活动</span>
        </div>
        <p className='recent-activity-empty'>暂无显著交易</p>
      </section>
    );
  }

  return (
    <section className='recent-activity-timeline' aria-label='近期活动'>
      <div className='recent-activity-header'>
        <span className='recent-activity-title'>近期活动</span>
      </div>
      <ul className='recent-activity-items'>
        {significant.map((t) => (
          <li key={t.journal_id} className='recent-activity-item'>
            <div className='recent-activity-info'>
              <span className='recent-activity-desc'>{t.description || t.category}</span>
              <span className='recent-activity-date'>{t.date}</span>
            </div>
            <span className='recent-activity-amount'>
              {t.amount_base === null
                ? <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap font-[var(--font-family-mono)] [font-variant-numeric:tabular-nums] [font-feature-settings:'tnum'_1] [.transaction-card-value_&]:whitespace-normal [.comp-donut-center_&]:font-semibold text-[var(--danger-600)]" title="汇率缺失，无法折算">汇率缺失</span>
                : <Amount value={t.amount_base} currency={baseCurrency} />}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
