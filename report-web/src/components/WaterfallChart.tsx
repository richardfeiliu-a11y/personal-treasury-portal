import { EChart } from "./Chart";
import { EmptyState } from "./EmptyState";
import { AlertTriangle } from "lucide-react";
import { waterfallOption } from "../utils/chartOptions";
import type { WaterfallReconciledData } from "../utils/waterfallReconciliation";

/**
 * FX 不完整微提醒横幅（spec §9 / WP4 Step 4）：
 * inline banner，非全屏阻断，图表仍渲染可用数据。
 */
function FxMicroAlert({ baseCurrency }: { baseCurrency: string }) {
  return (
    <div className="banner waterfall-fx-alert flex items-start gap-2 py-2.5 px-3 rounded-[10px] border border-solid text-[13px] leading-[20px] font-normal [&_ul]:m-0 [&_ul]:pl-[18px] [.error-boundary_&]:max-w-[560px] [.error-boundary_&_p]:m-0 [.error-boundary_&_button]:ml-[auto] [.error-boundary_&_button]:py-1.5 [.error-boundary_&_button]:px-3 [.error-boundary_&_button]:border [.error-boundary_&_button]:border-solid [.error-boundary_&_button]:border-[var(--danger-600)] [.error-boundary_&_button]:rounded-[8px] [.error-boundary_&_button]:bg-[var(--card)] [.error-boundary_&_button]:text-[var(--danger-700)] [.error-boundary_&_button]:text-[13px] [.error-boundary_&_button]:leading-[20px] [.error-boundary_&_button]:font-semibold [.error-boundary_&_button]:cursor-pointer [.error-boundary_&_button]:whitespace-nowrap bg-[var(--warning-100)] border-[var(--warning-600)] text-[var(--warning-800)]" role="alert" style={{ marginBottom: 8 }}>
      <AlertTriangle size={14} aria-hidden="true" className="[flex:0_0_auto] mt-0.5" />
      <span>汇率不完整：部分支出缺汇率，瀑布图仅展示可折合 {baseCurrency} 的数据。</span>
    </div>
  );
}

/**
 * 收支瀑布图组件（Task 2.1 / WP4）。
 *
 * 门禁未通过时渲染阻断态（空状态 + 差额披露）。
 * FX 不完整时渲染微提醒横幅 + 可用数据图表（spec §9）。
 */
export function WaterfallChart({
  data,
  baseCurrency,
}: {
  data: WaterfallReconciledData;
  baseCurrency: string;
}) {
  if (data.is_complete === false) {
    return (
      <div className="waterfall-blocked border border-solid border-[var(--danger-200)] bg-[var(--danger-50)] rounded-[10px] p-[var(--space-4)]">
        <EmptyState
          title="瀑布图已阻断"
          description={data.error ?? "收支勾稽未通过，瀑布图不渲染。"}
        />
      </div>
    );
  }
  return (
    <>
      {data.fx_incomplete && <FxMicroAlert baseCurrency={baseCurrency} />}
      <EChart option={waterfallOption(data.steps, baseCurrency)} ariaLabel="收支瀑布图" height={320} />
    </>
  );
}
