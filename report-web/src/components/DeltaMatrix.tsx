import { Amount } from "./Amount";
import { formatNumber } from "../utils/format";
import { calculateAccountDelta, type AccountDeltaResult } from "../utils/balanceSheetDelta";
import type { WebAccountGroup, WebAccountRow } from "../api/types";

/**
 * DeltaMatrix — WP3 §8.4
 * SINGLE DOM: desktop and mobile share one account-row, switched via CSS media query.
 * Avoids duplicate DOM that caused getByText collisions.
 */

interface DeltaMatrixProps {
  groups: WebAccountGroup[];
  compareByAccountId?: Map<string, WebAccountRow>;
  showDelta: boolean;
  baseCurrency: string;
}

/** 状态徽标 */
function StatusBadge({ status }: { status: AccountDeltaResult["status"] }) {
  if (status === "new") return <span className="inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)] ml-[var(--space-2)]">新增</span>;
  if (status === "closed") return <span className="inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)] ml-[var(--space-2)]">已退出 / 无余额</span>;
  if (status === "fx_incomplete") return <span className="inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)] bg-[var(--warning-100)] text-[var(--warning-800)] border-[var(--warning-100)] ml-[var(--space-2)]">汇率不完整</span>;
  return null;
}

/** Delta 指示器：中性箭头 / 零值灰 / 状态文案 */
function DeltaIndicator({ delta }: { delta: AccountDeltaResult }) {
  if (delta.status === "fx_incomplete") {
    return <span className="text-[var(--text-subtle)] [font:600_12px/1.4_var(--font-family-base)] [font-variant-numeric:tabular-nums] whitespace-nowrap">— (汇率不完整)</span>;
  }
  if (delta.status === "new" || delta.status === "closed") {
    return <StatusBadge status={delta.status} />;
  }
  if (delta.diff_percentage === null) {
    return <span className="text-[var(--text-subtle)] [font:600_12px/1.4_var(--font-family-base)] [font-variant-numeric:tabular-nums] whitespace-nowrap">—</span>;
  }
  if (delta.diff_percentage === 0) {
    return (
      <span className="text-[var(--text-subtle)] [font:600_12px/1.4_var(--font-family-base)] [font-variant-numeric:tabular-nums] whitespace-nowrap" style={{ color: "var(--text-faint)" }}>
        — 0%
      </span>
    );
  }
  const arrow = delta.diff_percentage > 0 ? "↑ +" : "↓ ";
  return (
    <span className="text-[var(--text-subtle)] [font:600_12px/1.4_var(--font-family-base)] [font-variant-numeric:tabular-nums] whitespace-nowrap" title={`较对比期 ${formatNumber(delta.diff_amount)} CNY`}>
      {arrow}{delta.diff_percentage}%
    </span>
  );
}

/**
 * 账户行 — 单 DOM。
 * 桌面：flex 行布局。移动 ≤640px：CSS media query 切换为两行 KV 布局（ALIGN-06）。
 */
function DeltaAccountRow({
  account,
  baseCurrency,
  compare,
  showDelta,
}: {
  account: WebAccountRow;
  baseCurrency: string;
  compare?: WebAccountRow;
  showDelta: boolean;
}) {
  const missing = account.balance_base === null && Number(account.balance_native) !== 0;
  const delta = showDelta ? calculateAccountDelta(account, compare) : undefined;

  return (
    <div
      className={`flex items-center justify-between gap-[var(--space-3)] border-b border-[var(--border-soft)] px-0 py-[var(--space-3)] [font:var(--type-body)] last:border-b-0 max-sm:flex-col max-sm:items-start max-sm:gap-0.5${!account.active ? " opacity-0.65" : ""}${missing ? " bg-[var(--warning-100)]" : ""}`}
    >
      <span className="text-[var(--text-body)] max-sm:block max-sm:mb-0.5" title={account.active ? undefined : "停用账户"}>
        {account.name}
        {!account.active && <span className="inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)] ml-[var(--space-2)]">停用</span>}
        {missing && <span className="inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)] bg-[var(--warning-100)] text-[var(--warning-800)] border-[var(--warning-100)] ml-[var(--space-2)]">缺汇率</span>}
      </span>
      <span className="flex flex-col items-end gap-0.5 [font-variant-numeric:tabular-nums] max-sm:flex-row max-sm:items-baseline max-sm:gap-[var(--space-2)] max-sm:justify-end">
        <Amount value={account.balance_native} currency={account.currency} />
        {account.balance_base !== null ? (
          <span className="balance-row-converted text-[var(--text-faint)] [font:var(--type-caption)]">
            ≈ <Amount value={account.balance_base} currency={baseCurrency} />
          </span>
        ) : (
          <span className="text-[var(--text-faint)] [font:var(--type-caption)]">汇率缺失</span>
        )}
        {delta && <DeltaIndicator delta={delta} />}
      </span>
    </div>
  );
}

function EmptyStateInline({ title, description }: { title: string; description?: string }) {
  return (
    <div className="empty-state flex flex-col items-center justify-center text-center py-[var(--space-8)] px-[var(--space-4)] text-[var(--text-faint)] [.waterfall-blocked_&]:p-0" role="status">
      <div className="title">{title}</div>
      {description && <div className="desc">{description}</div>}
    </div>
  );
}

function GroupCard({
  title,
  subtotal,
  currency,
  children,
}: {
  title: string;
  subtotal: string | null;
  currency: string;
  children: React.ReactNode;
}) {
  return (
    <section className="balance-group balance-group-card bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)]" aria-label={title}>
      <header className="balance-group-head flex items-center justify-between gap-[var(--space-3)] py-3 px-[var(--space-5)] min-h-11 border-b border-b-[var(--border-soft)] text-[14px] leading-[22px] font-semibold text-[var(--text-strong)]">
        <span>{title}</span>
        <span className="subtotal">
          <span className="absolute w-px h-px m-[-1px] p-0 overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap border-0">{title}小计 </span>
          <Amount value={subtotal} currency={currency} />
        </span>
      </header>
      <div className="pt-1 px-[var(--space-5)] pb-[var(--space-3)]">{children}</div>
    </section>
  );
}

/**
 * DeltaMatrix：完整的账户对比矩阵。
 * SINGLE DOM — 桌面与移动端共享同一份 account-row，使用 CSS media query 在
 * flex 行布局（桌面）与两行 KV 布局（≤640px）之间切换。
 */
export function DeltaMatrix({
  groups,
  compareByAccountId,
  showDelta,
  baseCurrency,
}: DeltaMatrixProps) {
  const assetGroups = groups.filter((g) => g.side === "asset");
  const liabilityGroups = groups.filter((g) => g.side === "liability");

  return (
    <div className="balance-columns w-full grid [grid-template-columns:minmax(0,_1.15fr)_minmax(0,_0.85fr)] gap-[var(--space-6)] [align-items:start] max-[1439px]:[grid-template-columns:1fr]">
      <DeltaSide
        label="资产"
        groups={assetGroups}
        compareByAccountId={compareByAccountId}
        showDelta={showDelta}
        baseCurrency={baseCurrency}
        emptyTitle="暂无资产账户"
        emptyDesc="当前截止日期没有纳入资产侧的账户。"
      />
      <DeltaSide
        label="负债"
        groups={liabilityGroups}
        compareByAccountId={compareByAccountId}
        showDelta={showDelta}
        baseCurrency={baseCurrency}
        emptyTitle="暂无负债账户"
        emptyDesc="当前截止日期没有纳入负债侧的账户。"
      />
    </div>
  );
}

/** 资产/负债侧 */
function DeltaSide({
  label,
  groups,
  compareByAccountId,
  showDelta,
  baseCurrency,
  emptyTitle,
  emptyDesc,
}: {
  label: string;
  groups: WebAccountGroup[];
  compareByAccountId?: Map<string, WebAccountRow>;
  showDelta: boolean;
  baseCurrency: string;
  emptyTitle: string;
  emptyDesc: string;
}) {
  return (
    <section aria-label={label} className="delta-side">
      <h2 className="balance-section-title m-0 [font:var(--type-section-title)] text-[var(--text-strong)] [.home-analysis-grid_&]:min-w-0 [.home-analysis-grid_&]:text-left [.home-summary-grid_&]:min-w-0 [.home-summary-grid_&]:text-left [.home-expense-ranking_&]:min-w-0 [.home-expense-ranking_&]:text-left [.anomaly-group_&]:mb-[var(--space-3)] mb-[var(--space-3)]">{label}</h2>
      {groups.length === 0 ? (
        <EmptyStateInline title={emptyTitle} description={emptyDesc} />
      ) : (
        <div className="flex flex-col gap-[var(--space-4)]">
          {groups.map((g) => (
            <GroupCard key={g.key} title={g.title} subtotal={g.subtotal_base} currency={baseCurrency}>
              {g.accounts.length === 0 ? (
                <div className="py-[var(--space-4)] px-[var(--space-5)] text-[var(--text-faint)] [font:var(--type-caption)]">该分组暂无账户。</div>
              ) : (
                g.accounts.map((a) => (
                  <DeltaAccountRow
                    key={a.id}
                    account={a}
                    baseCurrency={baseCurrency}
                    compare={showDelta ? compareByAccountId?.get(a.id) : undefined}
                    showDelta={showDelta}
                  />
                ))
              )}
            </GroupCard>
          ))}
        </div>
      )}
    </section>
  );
}
