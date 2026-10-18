import { useNavigate } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Amount, SignedAmount } from "../../components/Amount";

/**
 * 首页 Block 2（home 专用）：本月 MTD 四指标。
 * 整块为链接，跳转账本页并保留同一期间；语义色克制（收入绿 / 支出赭红）。
 * 保留 role=link + 键盘可达；aria-label「本月收支概览」。
 */
export function HomePnlStrip({
  period,
  income,
  expenses,
  netResult,
  savingsRate,
  currency,
}: {
  period: { start: string; end: string };
  income: string | null;
  expenses: string | null;
  netResult: string | null;
  savingsRate: string | null;
  currency: string;
}) {
  const navigate = useNavigate();
  const go = () =>
    navigate(`/income-expense?start=${period.start}&end=${period.end}`);

  return (
    <section
      className="pnl-flow-strip cursor-pointer select-none bg-[var(--card)] border border-solid border-[var(--border-soft)] rounded-xl py-4 px-5 [transition:box-shadow_0.15s] hover:shadow-[var(--shadow-hover)]"
      aria-label="本月收支概览"
      role="link"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      }}
    >
      <div className="pnl-flow-strip-header flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <span className="pnl-flow-strip-title text-[14px] font-semibold text-[var(--foreground)]">
            本月收支
          </span>
          <span className="text-[12px] text-[var(--delta-neutral)]">月至今</span>
        </div>
        <span className="inline-flex items-center gap-0.5 text-[12px] text-[var(--delta-neutral)]">
          查看详情
          <ChevronRight size={13} aria-hidden="true" />
        </span>
      </div>

      <div className="pnl-flow-strip-items mt-4 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <PnlItem label="收入" tone="income">
          <Amount value={income} currency={currency} />
        </PnlItem>
        <PnlItem label="支出" tone="expense">
          <Amount value={expenses} currency={currency} />
        </PnlItem>
        <PnlItem label="结余" tone="net">
          <SignedAmount value={netResult} currency={currency} />
        </PnlItem>
        <PnlItem label="储蓄率" tone="rate">
          {savingsRate !== null && savingsRate !== undefined
            ? `${Number(savingsRate).toFixed(1)}%`
            : "—"}
        </PnlItem>
      </div>
    </section>
  );
}

const TONE_TEXT = {
  income: "pnl-flow-income text-[var(--delta-positive)]",
  expense: "pnl-flow-expense text-[var(--delta-negative)]",
  net: "pnl-flow-net text-[var(--foreground)]",
  rate: "pnl-flow-rate text-[var(--foreground)]",
} as const;

function PnlItem({
  label,
  tone,
  children,
}: {
  label: string;
  tone: keyof typeof TONE_TEXT;
  children: React.ReactNode;
}) {
  return (
    <div className="pnl-flow-item flex min-w-0 flex-col gap-1.5">
      <span className="pnl-flow-label text-[12.5px] text-[var(--delta-neutral)]">{label}</span>
      <span
        className={`pnl-flow-value ${TONE_TEXT[tone]} text-[19px] font-semibold leading-7 tracking-[-0.01em] tabular-nums`}
      >
        {children}
      </span>
    </div>
  );
}
