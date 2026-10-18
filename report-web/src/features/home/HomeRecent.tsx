import { Amount } from "../../components/Amount";
import type { TransactionRow } from "../../api/types";

export function HomeRecent({
  transactions,
  baseCurrency,
}: {
  transactions: TransactionRow[];
  baseCurrency: string;
}) {
  // 显著交易：折算金额 > 1000，或打 significant 标签。缺折算行仅凭标签入选
  // （金额不过滤，避免把「缺汇率」当成 0）。
  const significant = transactions
    .filter(
      (t) =>
        (t.amount_base !== null && Math.abs(Number(t.amount_base)) > 1000) ||
        t.tags.includes("significant"),
    )
    .slice(0, 5);

  return (
    <section className={`recent-activity-timeline bg-[var(--card)] border border-solid border-[var(--border-soft)] rounded-xl px-5 ${significant.length < 3 ? "py-3" : "py-4"}`} aria-label="近期活动">
      <div className="flex justify-between items-center mb-3">
        <span className="text-[14px] font-semibold text-[var(--text-muted)]">近期活动</span>
      </div>

      {significant.length === 0 ? (
        <p className="text-[13px] text-[var(--text-faint)] text-center py-4 px-0 m-0">暂无显著交易</p>
      ) : (
        <ul className="list-none m-0 p-0">
          {significant.map((t) => (
            <li key={t.journal_id} className="flex justify-between items-center py-2 px-0 border-b border-b-[var(--border-soft)] last:border-b-0">
              <span className="flex flex-col gap-0.5">
                <span className="text-[14px] font-medium text-[var(--text-body)]">
                  {t.description || t.category}
                </span>
                <span className="text-[12px] text-[var(--text-faint)]">{t.date}</span>
              </span>
              <span className="text-[14px] font-semibold [font-variant-numeric:tabular-nums]">
                {t.amount_base === null ? (
                  <span
                    className="inline-flex items-baseline gap-1.5 whitespace-nowrap font-[var(--font-family-mono)] [font-variant-numeric:tabular-nums] [font-feature-settings:'tnum'_1] [.transaction-card-value_&]:whitespace-normal [.comp-donut-center_&]:font-semibold text-[var(--danger-600)]"
                    title="汇率缺失，无法折算"
                  >
                    汇率缺失
                  </span>
                ) : (
                  <Amount value={t.amount_base} currency={baseCurrency} />
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
