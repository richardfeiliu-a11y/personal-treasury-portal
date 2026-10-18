import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { todayIso } from "../utils/dates";

interface DatePickerProps {
  value: string;
  maxDate?: string;
  onChange: (date: string) => void;
  onClose: () => void;
  open: boolean;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const FOCUSABLE_SELECTOR = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function DatePicker({ value, maxDate, onChange, onClose, open }: DatePickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const initialMonth = useMemo(() => startOfMonth(parseLocalDate(value)), [value]);
  const [viewMonth, setViewMonth] = useState(initialMonth);

  useEffect(() => {
    if (open) {
      setViewMonth(startOfMonth(parseLocalDate(value)));
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return;

    function focusables() {
      return Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
    }

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !panelRef.current?.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !panelRef.current?.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    }

    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open) return;
    previousActiveElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const first = panelRef.current?.querySelector<HTMLElement>(
      ".date-picker-day.is-selected, .date-picker-day:not(:disabled), button:not(:disabled)",
    );
    first?.focus();

    return () => {
      const previous = previousActiveElementRef.current;
      if (previous && previous.isConnected) previous.focus();
      previousActiveElementRef.current = null;
    };
  }, [open]);

  const calendarDays = useMemo(() => {
    const year = viewMonth.getFullYear();
    const month = viewMonth.getMonth();
    const firstWeekday = viewMonth.getDay();
    const totalDays = daysInMonth(year, month);
    const prevTotalDays = daysInMonth(year, month - 1);

    const days: Array<{ date: Date; iso: string; currentMonth: boolean }> = [];

    // 上月补尾
    for (let i = firstWeekday - 1; i >= 0; i--) {
      const d = prevTotalDays - i;
      days.push({ date: new Date(year, month - 1, d), iso: formatIso(new Date(year, month - 1, d)), currentMonth: false });
    }

    // 当月
    for (let d = 1; d <= totalDays; d++) {
      days.push({ date: new Date(year, month, d), iso: formatIso(new Date(year, month, d)), currentMonth: true });
    }

    // 下月补头（补齐 42 格 = 6 行）
    const remaining = 42 - days.length;
    for (let d = 1; d <= remaining; d++) {
      days.push({ date: new Date(year, month + 1, d), iso: formatIso(new Date(year, month + 1, d)), currentMonth: false });
    }

    return days;
  }, [viewMonth]);

  const handlePrev = () => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1));
  const handleNext = () => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1));

  const handleSelect = (iso: string) => {
    onChange(iso);
    onClose();
  };

  if (!open) return null;

  const max = maxDate ? parseLocalDate(maxDate) : undefined;
  const today = todayIso();

  return (
    <div
      ref={panelRef}
      className="absolute top-[calc(100%_+_var(--space-2))] right-0 z-100 w-[280px] p-[var(--space-3)] rounded-[var(--radius)] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border border-solid border-[var(--glass-border)] shadow-[var(--shadow-lg)] text-[var(--text-body)]"
      role="dialog"
      aria-label="选择日期"
      aria-modal="true"
      tabIndex={-1}
    >
      <div className="date-picker-header flex items-center justify-between mb-[var(--space-3)] py-0 px-[var(--space-1)]">
        <button type="button" className="w-9 p-0 [.date-picker-header_&]:relative [.date-picker-header_&]:w-7 [.date-picker-header_&]:h-7 [.date-picker-header_&]:rounded-[10px] [.date-picker-header_&]:border [.date-picker-header_&]:border-solid [.date-picker-header_&]:border-[var(--border-default)] [.date-picker-header_&]:bg-transparent [.date-picker-header_&]:text-[var(--text-subtle)] [.date-picker-header_&]:inline-flex [.date-picker-header_&]:items-center [.date-picker-header_&]:justify-center [.date-picker-header_&]:cursor-pointer [.date-picker-header_&]:[transition:background_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] [.date-picker-header_&]:bg-[var(--surface-subtle)] [.date-picker-header_&]:text-[var(--text-body)] [.date-picker-header_&]:[content:''] [.date-picker-header_&]:absolute [.date-picker-header_&]:top-[50%] [.date-picker-header_&]:left-[50%] [.date-picker-header_&]:w-11 [.date-picker-header_&]:h-11 [.date-picker-header_&]:[transform:translate(-50%,_-50%)]" aria-label="上月" onClick={handlePrev}>
          <ChevronLeft size={16} />
        </button>
        <span className="[font:var(--type-body)] font-semibold text-[var(--text-body)]">
          {viewMonth.getFullYear()}年{String(viewMonth.getMonth() + 1).padStart(2, "0")}月
        </span>
        <button type="button" className="w-9 p-0 [.date-picker-header_&]:relative [.date-picker-header_&]:w-7 [.date-picker-header_&]:h-7 [.date-picker-header_&]:rounded-[10px] [.date-picker-header_&]:border [.date-picker-header_&]:border-solid [.date-picker-header_&]:border-[var(--border-default)] [.date-picker-header_&]:bg-transparent [.date-picker-header_&]:text-[var(--text-subtle)] [.date-picker-header_&]:inline-flex [.date-picker-header_&]:items-center [.date-picker-header_&]:justify-center [.date-picker-header_&]:cursor-pointer [.date-picker-header_&]:[transition:background_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] [.date-picker-header_&]:bg-[var(--surface-subtle)] [.date-picker-header_&]:text-[var(--text-body)] [.date-picker-header_&]:[content:''] [.date-picker-header_&]:absolute [.date-picker-header_&]:top-[50%] [.date-picker-header_&]:left-[50%] [.date-picker-header_&]:w-11 [.date-picker-header_&]:h-11 [.date-picker-header_&]:[transform:translate(-50%,_-50%)]" aria-label="下月" onClick={handleNext}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="grid [grid-template-columns:repeat(7,_1fr)] gap-1" role="grid">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-center [font:var(--type-caption)] font-medium text-[var(--text-faint)] py-[var(--space-1)] px-0" role="columnheader">
            {w}
          </div>
        ))}
        {calendarDays.map(({ iso, currentMonth }) => {
          const disabled = Boolean(max && parseLocalDate(iso) > max);
          const selected = iso === value;
          const isToday = iso === today;
          return (
            <button
              key={iso}
              type="button"
              role="gridcell"
              disabled={disabled}
              aria-selected={selected}
              className={
                "relative flex aspect-square items-center justify-center rounded-[10px] border text-xs font-medium "
                + (selected
                    ? "border-[var(--brand-accent)] bg-[var(--brand-accent)] text-white "
                    : isToday
                      ? "border-[var(--brand-accent)] text-[var(--brand-text)] "
                      : currentMonth
                        ? "border-transparent text-[var(--text-muted)] hover:border-[var(--divider)] hover:bg-[var(--surface-subtle)] "
                        : "border-transparent text-[var(--text-placeholder)] ")
                + (disabled ? "cursor-not-allowed text-[var(--text-disabled)]" : "")
              }
              onClick={() => !disabled && handleSelect(iso)}
            >
              {Number(iso.slice(8, 10))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
