/** Skeleton 占位（spec §13 Loading）：优先骨架而非纯 spinner。 */

export function SkeletonLine({ width = "100%", height = 12 }: { width?: number | string; height?: number }) {
  return <div className="bg-[linear-gradient(90deg,_var(--surface-subtle)_25%,_var(--surface-shimmer)_50%,_var(--surface-subtle)_75%)] bg-[length:200%_100%] animate-none rounded-[8px]" style={{ width, height }} aria-busy="true" aria-hidden="true" />;
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={`flex flex-col gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--card)] p-5 shadow-[var(--shadow-card)] ${className ?? ""}`} aria-busy="true" aria-label="加载中">
      <SkeletonLine width="45%" />
      <div style={{ height: 10 }} />
      <SkeletonLine width="70%" height={22} />
      <div style={{ height: 6 }} />
      <SkeletonLine width="55%" height={12} />
    </div>
  );
}

export function SkeletonBlock({ height = 200 }: { height?: number }) {
  return <div className="bg-[linear-gradient(90deg,_var(--surface-subtle)_25%,_var(--surface-shimmer)_50%,_var(--surface-subtle)_75%)] bg-[length:200%_100%] animate-none rounded-[8px] rounded-xl [.balance-loading-groups>&]:min-w-0 max-md:[.transactions-loading-layout>&]:hidden" style={{ height }} aria-busy="true" aria-label="加载中" />;
}
