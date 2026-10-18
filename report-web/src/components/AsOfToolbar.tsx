import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { berlinLastMonthEnd, berlinLastYearEnd, berlinTodayIso } from "../utils/dates";
import { DatePicker } from "./DatePicker";
import { BASE_BTNCHIP, BTNCHIP_ISACTIVE } from "../utils/legacyClasses";

export interface AsOfToolbarProps {
  asOf: string;
  onAsOfChange: (date: string) => void;
  maxDate?: string;
}

/** 时点存量工具栏：预设芯片 + 自定义日期。严格仅绑定 BalanceSheet（Accounts 保持不变）。
 *  DATA-01：预设值直接写进 as_of 请求参数，故全部按 Europe/Berlin 业务日历产出。 */
export function AsOfToolbar({ asOf, onAsOfChange, maxDate = berlinTodayIso() }: AsOfToolbarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const customTriggerRef = useRef<HTMLButtonElement>(null);
  const pickerWasOpenRef = useRef(false);
  const presets = useMemo(
    () => [
      { label: "今日最新", value: berlinTodayIso() },
      { label: "上月末", value: berlinLastMonthEnd() },
      { label: "去年末", value: berlinLastYearEnd() },
    ],
    [],
  );

  const fixedValues = useMemo(() => new Set(presets.map((p) => p.value)), [presets]);
  const isCustom = !fixedValues.has(asOf);

  const handleCustomClick = () => setPickerOpen((v) => !v);

  // DatePicker owns the modal focus while open; restore focus to its trigger after unmount.
  // This also covers programmatic close and environments where a synthetic click does not focus a button.
  useEffect(() => {
    if (pickerWasOpenRef.current && !pickerOpen) {
      customTriggerRef.current?.focus();
    }
    pickerWasOpenRef.current = pickerOpen;
  }, [pickerOpen]);

  return (
    <div className="as-of-toolbar relative inline-flex flex-row items-center gap-[var(--space-2)] max-md:flex-wrap max-sm:items-start max-sm:flex-wrap max-sm:min-w-0 max-sm:max-w-full max-sm:w-full">
      <span className="text-[var(--text-faint)] [font:var(--type-caption)] font-medium whitespace-nowrap" id="as-of-label">
        截止日期
      </span>
      <div className="inline-flex items-center gap-[var(--space-1)] flex-nowrap max-sm:[.as-of-toolbar_&]:[flex:1_1_auto] max-sm:[.as-of-toolbar_&]:min-w-0 max-sm:[.period-toolbar_&]:max-w-full max-sm:[.period-toolbar_&]:min-w-0 max-sm:[.period-toolbar_&]:overflow-x-auto max-sm:[.period-toolbar_&]:overflow-y-hidden max-sm:[.period-toolbar_&]:flex-nowrap max-sm:[.period-toolbar_&]:[scrollbar-width:thin] max-sm:[.as-of-toolbar_&]:max-w-full max-sm:[.as-of-toolbar_&]:overflow-x-auto max-sm:[.as-of-toolbar_&]:overflow-y-hidden max-sm:[.as-of-toolbar_&]:flex-nowrap max-sm:[.as-of-toolbar_&]:[scrollbar-width:thin]" role="group" aria-label="截止时点快捷选项">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`${ BASE_BTNCHIP } max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)]${ asOf === p.value ? ` is-active ${ BTNCHIP_ISACTIVE }` : "" }`}
            onClick={() => onAsOfChange(p.value)}
          >
            {p.label}
          </button>
        ))}
        {isCustom ? (
          <button
            ref={customTriggerRef}
            type="button"
            className="is-active inline-flex items-center h-[30px] py-0 px-3 rounded-full bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border border-solid border-[var(--border-default)] text-[var(--text-muted)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] hover:border-[var(--border-emphasis)] hover:text-[var(--text-body)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] !bg-[var(--secondary)] !text-[var(--brand-text)] !border-[var(--brand-accent)]"
            aria-label="自定义日期"
            onClick={handleCustomClick}
          >
            <CalendarDays size={14} aria-hidden="true" />
            {asOf}
          </button>
        ) : (
          <button
            ref={customTriggerRef}
            type="button"
            className="inline-flex items-center h-[30px] py-0 px-3 rounded-full bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border border-solid border-[var(--border-default)] text-[var(--text-muted)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] hover:border-[var(--border-emphasis)] hover:text-[var(--text-body)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [.tab-chip-row_&]:bg-transparent [.tab-chip-row_&]:border [.tab-chip-row_&]:border-solid [.tab-chip-row_&]:border-[var(--border-emphasis)] [.tab-chip-row_&]:text-[var(--text-muted)] [.tab-chip-row_&]:py-1.5 [.tab-chip-row_&]:px-3 [.tab-chip-row_&]:rounded-full [.tab-chip-row_&]:[font:var(--type-label)] [.tab-chip-row_&]:no-underline [.tab-chip-row_&]:[transition:background_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] [.tab-chip-row_&]:bg-[var(--surface-subtle)] [.tab-chip-row_&]:text-[var(--text-body)] [.tab-chip-row_&]:bg-[var(--secondary)] [.tab-chip-row_&]:border-[var(--brand-accent)] [.tab-chip-row_&]:text-[var(--brand-text)] [.tab-chip-row_&]:font-semibold"
            aria-label="自定义日期"
            onClick={handleCustomClick}
          >
            自定义日期
          </button>
        )}
      </div>
      <DatePicker
        value={asOf}
        maxDate={maxDate}
        open={pickerOpen}
        onChange={onAsOfChange}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
