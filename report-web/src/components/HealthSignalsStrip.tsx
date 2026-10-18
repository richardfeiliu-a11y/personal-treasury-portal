import { useNavigate } from 'react-router-dom';
import type { AnomalyRow } from '../api/types';
import { filterVisibleAnomalies } from '../utils/anomalyFilters';
import { getDismissals } from '../utils/snooze';

/**
 * Block 3 — HealthSignalsStrip (Spec v1.2 §7-bis.2)
 * Critical 契约：3px --warning-500 左边框 + 「有 N 个请关注」
 * 非 critical 或 N=0 时完全隐藏（返回 null）
 */
export function HealthSignalsStrip({
  anomalies,
}: {
  anomalies: AnomalyRow[];
}) {
  const navigate = useNavigate();
  // 提醒面只统计用户未关闭的异常：已关闭（temporary/permanent）不计入
  const visibleAnomalies = filterVisibleAnomalies(anomalies, getDismissals(), { showSnoozed: false });
  const criticals = visibleAnomalies.filter((a) => a.severity === 'critical');

  // spec v1.2 §7-bis.2: 仅在有 critical 异常时渲染，非 critical 或无异常时完全隐藏
  if (criticals.length === 0) {
    return null;
  }

  function handleNav() { navigate('/alerts'); }

  return (
    <section
      className='health-signals-strip health-signals-strip--critical flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-solid border-[var(--danger-200)] bg-[var(--surface-tint-danger)] px-3.5 py-2.5 transition-colors hover:brightness-95'
      aria-label='财务健康信号'
      role='link'
      tabIndex={0}
      onClick={handleNav}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleNav();
        }
      }}
    >
      <span aria-hidden='true' className='h-2 w-2 shrink-0 rounded-full bg-[var(--danger-500)]' />
      <span className='health-signals-title text-[13px] font-medium text-[var(--delta-negative)]'>
        有 {criticals.length} 个请关注
      </span>
      <span className='ml-auto text-[12px] text-[var(--delta-negative)]'>查看</span>
    </section>
  );
}
