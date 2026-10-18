import { AlertTriangle, RefreshCw } from "lucide-react";

export function WarningBanner({
  items,
  onRefresh,
  testId,
}: {
  items: string[];
  onRefresh?: () => void;
  /** 可选测试锚点（REL-05 过期横幅需要稳定定位，不改变渲染结构）。 */
  testId?: string;
}) {
  const unique = [...new Set(items)];
  if (!unique.length) return null;
  return (
    <div className="banner flex items-start gap-2 py-2.5 px-3 rounded-[10px] border border-solid text-[13px] leading-[20px] font-normal [&_ul]:m-0 [&_ul]:pl-[18px] [.error-boundary_&]:max-w-[560px] [.error-boundary_&_p]:m-0 [.error-boundary_&_button]:ml-[auto] [.error-boundary_&_button]:py-1.5 [.error-boundary_&_button]:px-3 [.error-boundary_&_button]:border [.error-boundary_&_button]:border-solid [.error-boundary_&_button]:border-[var(--danger-600)] [.error-boundary_&_button]:rounded-[8px] [.error-boundary_&_button]:bg-[var(--card)] [.error-boundary_&_button]:text-[var(--danger-700)] [.error-boundary_&_button]:text-[13px] [.error-boundary_&_button]:leading-[20px] [.error-boundary_&_button]:font-semibold [.error-boundary_&_button]:cursor-pointer [.error-boundary_&_button]:whitespace-nowrap bg-[var(--warning-100)] border-[var(--warning-600)] text-[var(--warning-800)]" role="alert" data-testid={testId}>
      <AlertTriangle size={16} aria-hidden="true" className="[flex:0_0_auto] mt-0.5" />
      <ul>
        {unique.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
      {onRefresh && (
        <button type="button" className="ml-[auto] inline-flex items-center gap-1 border-0 bg-transparent text-inherit underline whitespace-nowrap [font:inherit] max-md:[.balance-sheet-page_&]:min-h-[var(--touch-target)] max-md:[.income-expense-page_&]:min-h-[var(--touch-target)] max-md:[.trends-page_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_&]:min-h-[var(--touch-target)] max-md:[.alerts-page_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)]" onClick={onRefresh}>
          <RefreshCw size={14} aria-hidden="true" /> 刷新
        </button>
      )}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner flex items-start gap-2 py-2.5 px-3 rounded-[10px] border border-solid text-[13px] leading-[20px] font-normal [&_ul]:m-0 [&_ul]:pl-[18px] [.error-boundary_&]:max-w-[560px] [.error-boundary_&_p]:m-0 [.error-boundary_&_button]:ml-[auto] [.error-boundary_&_button]:py-1.5 [.error-boundary_&_button]:px-3 [.error-boundary_&_button]:border [.error-boundary_&_button]:border-solid [.error-boundary_&_button]:border-[var(--danger-600)] [.error-boundary_&_button]:rounded-[8px] [.error-boundary_&_button]:bg-[var(--card)] [.error-boundary_&_button]:text-[var(--danger-700)] [.error-boundary_&_button]:text-[13px] [.error-boundary_&_button]:leading-[20px] [.error-boundary_&_button]:font-semibold [.error-boundary_&_button]:cursor-pointer [.error-boundary_&_button]:whitespace-nowrap bg-[var(--danger-100)] border-[var(--danger-600)] text-[var(--danger-600)]" role="alert">
      <AlertTriangle size={16} aria-hidden="true" className="[flex:0_0_auto] mt-0.5" />
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="ml-[auto] inline-flex items-center gap-1 border-0 bg-transparent text-inherit underline whitespace-nowrap [font:inherit] max-md:[.balance-sheet-page_&]:min-h-[var(--touch-target)] max-md:[.income-expense-page_&]:min-h-[var(--touch-target)] max-md:[.trends-page_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_&]:min-h-[var(--touch-target)] max-md:[.alerts-page_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)]" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" /> 重试
        </button>
      )}
    </div>
  );
}
