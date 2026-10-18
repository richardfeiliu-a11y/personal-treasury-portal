import {
  BASE_BTNCHIP,
  BTNCHIP_ISACTIVE,
  BASE_PERIODTOOLBARERROR,
  PERIODTOOLBARERROR_ISVISIBLE,
} from "../utils/legacyClasses";

export interface PeriodPreset {
  key: string;
  label: string;
}

export interface PeriodToolbarProps {
  fromDate: string;
  toDate: string;
  onFromDateChange: (value: string) => void;
  onToDateChange: (value: string) => void;
  error?: string;
  /** 快捷期间芯片（如 近30天/本月/上月/今年/自定义）；不传则保持纯日期区间控件。 */
  presets?: PeriodPreset[];
  activePreset?: string;
  onPresetChange?: (key: string) => void;
}

const INVALID_PERIOD_MESSAGE = "起始日期不能晚于截止日期";

/** 统一日期区间控件（期间流量）：预设芯片 + 字段标签在上、校验信息在下。 */
export function PeriodToolbar({
  fromDate,
  toDate,
  onFromDateChange,
  onToDateChange,
  error,
  presets,
  activePreset,
  onPresetChange,
}: PeriodToolbarProps) {
  const message = error ?? (fromDate && toDate && fromDate > toDate ? INVALID_PERIOD_MESSAGE : undefined);
  const describedBy = message ? "period-error" : undefined;

  return (
    <div className="period-toolbar flex flex-col gap-[var(--space-1)] items-start max-md:w-full max-sm:w-full max-sm:min-w-0 max-sm:max-w-full">
      {presets && presets.length > 0 && onPresetChange && (
        <div className="inline-flex items-center gap-[var(--space-1)] flex-nowrap max-sm:[.as-of-toolbar_&]:[flex:1_1_auto] max-sm:[.as-of-toolbar_&]:min-w-0 max-sm:[.period-toolbar_&]:max-w-full max-sm:[.period-toolbar_&]:min-w-0 max-sm:[.period-toolbar_&]:overflow-x-auto max-sm:[.period-toolbar_&]:overflow-y-hidden max-sm:[.period-toolbar_&]:flex-nowrap max-sm:[.period-toolbar_&]:[scrollbar-width:thin] max-sm:[.as-of-toolbar_&]:max-w-full max-sm:[.as-of-toolbar_&]:overflow-x-auto max-sm:[.as-of-toolbar_&]:overflow-y-hidden max-sm:[.as-of-toolbar_&]:flex-nowrap max-sm:[.as-of-toolbar_&]:[scrollbar-width:thin]" role="group" aria-label="快捷期间">
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`${ BASE_BTNCHIP }${ activePreset === p.key ? ` ${ BTNCHIP_ISACTIVE }` : "" }`}
              aria-pressed={activePreset === p.key}
              onClick={() => onPresetChange(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-start gap-[var(--space-2)] max-md:w-full max-md:flex-col">
        <label className="period-toolbar-field flex flex-col gap-1.5 text-[var(--text-muted)] [font:var(--type-caption)] font-medium max-md:w-full" htmlFor="period-from">
          <span>起始日期</span>
          <input
            id="period-from"
            name="from_date"
            className="h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:400_14px/1_var(--font-family-base)] w-full [transition:border-color_var(--duration-hover)_var(--ease-standard),_box-shadow_var(--duration-hover)_var(--ease-standard)] focus:outline-none focus:border-[var(--brand-accent)] focus:shadow-[0_0_0_3px_rgba(40,_160,_111,_0.10)] [&::placeholder]:text-[var(--text-placeholder)] [.period-toolbar-field_&]:w-[150px] [.period-toolbar-field_&]:border-[var(--danger-600)] max-md:[.period-toolbar-field_&]:w-full max-md:[.income-expense-page_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.income-expense-page_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.transactions-page_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.page:has(.fx-currency-list)_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.page:has(.fx-currency-list)_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)]"
            type="date"
            value={fromDate}
            aria-describedby={describedBy}
            aria-invalid={message ? "true" : undefined}
            onChange={(event) => onFromDateChange(event.target.value)}
          />
        </label>
        <label className="period-toolbar-field flex flex-col gap-1.5 text-[var(--text-muted)] [font:var(--type-caption)] font-medium max-md:w-full" htmlFor="period-to">
          <span>截止日期</span>
          <input
            id="period-to"
            name="to_date"
            className="h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:400_14px/1_var(--font-family-base)] w-full [transition:border-color_var(--duration-hover)_var(--ease-standard),_box-shadow_var(--duration-hover)_var(--ease-standard)] focus:outline-none focus:border-[var(--brand-accent)] focus:shadow-[0_0_0_3px_rgba(40,_160,_111,_0.10)] [&::placeholder]:text-[var(--text-placeholder)] [.period-toolbar-field_&]:w-[150px] [.period-toolbar-field_&]:border-[var(--danger-600)] max-md:[.period-toolbar-field_&]:w-full max-md:[.income-expense-page_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.income-expense-page_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.transactions-page_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:h-[var(--touch-target)] max-md:[.transactions-page>.period-filter-row>&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.page:has(.fx-currency-list)_.period-toolbar-field_&]:h-[var(--touch-target)] max-md:[.page:has(.fx-currency-list)_.period-toolbar-field_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)]"
            type="date"
            value={toDate}
            aria-describedby={describedBy}
            aria-invalid={message ? "true" : undefined}
            onChange={(event) => onToDateChange(event.target.value)}
          />
        </label>
      </div>
      <p
        id="period-error"
        className={`${ BASE_PERIODTOOLBARERROR }${ message ? ` ${ PERIODTOOLBARERROR_ISVISIBLE }` : "" }`}
        role={message ? "alert" : undefined}
        aria-live="polite"
      >
        {message ?? "\u00a0"}
      </p>
    </div>
  );
}
