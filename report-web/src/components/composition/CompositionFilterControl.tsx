import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import type { SelectionState } from "../../utils/compositionSeries";
import { BASE_COMPFILTERROW, COMPFILTERROW_ISDISABLED } from "../../utils/legacyClasses";

/**
 * 构成分析筛选控件（spec §7.5）：trigger + badge、搜索、flat/tree checkbox、
 * desktop popover / mobile bottom sheet（同一 DOM，CSS 切换）、重置。
 *
 * - 复用 DatePicker 的 outside-click、Esc、focus trap、focus restore 模式；
 * - 不直接复用 MobileDrawer（导航专用，焦点回落硬编码）；
 * - 语义：`all` = 全选；`include` = 显式集合（可为空集）；「重置」回到 `all`。
 */
export interface FilterOption {
  key: string;
  label: string;
  disabled?: boolean;
  children?: FilterOption[];
}

export interface CompositionFilterControlProps {
  ariaLabel: string;
  options: FilterOption[];
  selection: SelectionState;
  onChange: (selection: SelectionState) => void;
  onReset: () => void;
  disabled?: boolean;
}

const FOCUSABLE_SELECTOR =
  "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

function leafKeys(options: FilterOption[]): Set<string> {
  const keys = new Set<string>();
  for (const option of options) {
    if (option.children && option.children.length > 0) {
      for (const child of option.children) keys.add(child.key);
    } else {
      keys.add(option.key);
    }
  }
  return keys;
}

function visibleOptions(options: FilterOption[], query: string): FilterOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options
    .map((option) => {
      if (option.children && option.children.length > 0) {
        const children = option.children.filter((c) => c.label.toLowerCase().includes(q));
        if (children.length > 0) return { ...option, children };
        return option.label.toLowerCase().includes(q) ? option : null;
      }
      return option.label.toLowerCase().includes(q) ? option : null;
    })
    .filter((o): o is FilterOption => o !== null);
}

function IndeterminateCheckbox({
  checked,
  indeterminate,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className={`${ BASE_COMPFILTERROW }${ disabled ? ` ${ COMPFILTERROW_ISDISABLED }` : "" }`}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
      />
      <span className="flex-1 overflow-hidden [text-overflow:ellipsis] whitespace-nowrap">{label}</span>
      {disabled ? <span className="[font:var(--type-caption)] text-[var(--text-placeholder)]">当前范围无数据</span> : null}
    </label>
  );
}

export function CompositionFilterControl({
  ariaLabel,
  options,
  selection,
  onChange,
  onReset,
  disabled,
}: CompositionFilterControlProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const panelId = useMemo(() => `comp-filter-panel-${ariaLabel}`, [ariaLabel]);

  const allKeys = useMemo(() => leafKeys(options), [options]);
  const effective = selection.kind === "all" ? allKeys : selection.keys;
  const selectedCount = selection.kind === "include" ? selection.keys.size : 0;
  const visible = useMemo(() => visibleOptions(options, query), [options, query]);

  const closePanel = () => setOpen(false);

  useEffect(() => {
    if (!open) return;

    function focusables(): HTMLElement[] {
      return Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);
    }

    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closePanel();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      const panel = panelRef.current;
      if (items.length === 0 || !panel) {
        e.preventDefault();
        panel?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }

    function handleMouseDown(e: MouseEvent) {
      // root 容器包含 trigger：trigger 的点击由其自身 onClick 处理（toggle），
      // 其余外部点击关闭。
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closePanel();
      }
    }

    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    previousActiveElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panelRef.current?.querySelector<HTMLElement>("input.comp-filter-search");
    (first ?? panelRef.current)?.focus();
    return () => {
      const previous = previousActiveElementRef.current;
      if (previous && previous.isConnected) previous.focus();
      previousActiveElementRef.current = null;
    };
  }, [open]);

  const toggleLeaf = (key: string) => {
    const next = new Set(effective);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange({ kind: "include", keys: next });
  };

  const toggleGroup = (group: FilterOption) => {
    const childKeys = (group.children ?? []).map((c) => c.key);
    const allSelected = childKeys.every((k) => effective.has(k));
    const next = new Set(effective);
    for (const k of childKeys) {
      if (allSelected) next.delete(k);
      else next.add(k);
    }
    onChange({ kind: "include", keys: next });
  };

  const hasOptions = options.length > 0;

  return (
    <div className="relative inline-flex items-center gap-1" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)] min-h-11"
        aria-haspopup="dialog"
        aria-expanded={open}
        // 面板仅在 open 时挂载：关闭时不输出 aria-controls，避免指向不存在的 id
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
      >
        {selectedCount > 0 ? `筛选 (${selectedCount})` : "筛选"}
      </button>
      {selectedCount > 0 ? (
        // 与 trigger 并列的真实按钮（button 内容模型禁止嵌套交互元素）
        <button
          type="button"
          className="inline-flex items-center justify-center w-[22px] h-[22px] border-0 rounded-full bg-[var(--surface-subtle)] text-[var(--text-faint)] cursor-pointer transition-none hover:bg-[var(--surface-shimmer)] hover:text-[var(--text-body)]"
          aria-label="清除筛选"
          title="清除筛选"
          onClick={onReset}
        >
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          className="comp-filter-panel absolute top-[calc(100%_+_6px)] right-0 z-[var(--z-popover,_40)] w-[min(280px,_calc(100vw_-_32px))] max-h-[320px] flex flex-col bg-[var(--card)] border border-solid border-[var(--border-soft)] rounded-xl shadow-[var(--shadow-md)] pt-[var(--space-2)] px-0 pb-0 max-sm:fixed max-sm:top-[auto] max-sm:right-[auto] max-sm:w-full max-sm:max-h-[70vh] max-sm:rounded-[var(--radius-card)_var(--radius-card)_0_0] max-sm:inset-[auto_0_0_0] max-sm:left-0 max-sm:h-[70vh] max-sm:pb-[env(safe-area-inset-bottom,_0)]"
          role="dialog"
          aria-label={ariaLabel}
          tabIndex={-1}
        >
          <div className="flex items-center justify-between py-0 px-[var(--space-3)] min-h-11">
            <span className="[font:var(--type-body)] font-semibold text-[var(--text-body)]">{ariaLabel}</span>
            <button
              type="button"
              className="w-9 p-0 [.date-picker-header_&]:relative [.date-picker-header_&]:w-7 [.date-picker-header_&]:h-7 [.date-picker-header_&]:rounded-[10px] [.date-picker-header_&]:border [.date-picker-header_&]:border-solid [.date-picker-header_&]:border-[var(--border-default)] [.date-picker-header_&]:bg-transparent [.date-picker-header_&]:text-[var(--text-subtle)] [.date-picker-header_&]:inline-flex [.date-picker-header_&]:items-center [.date-picker-header_&]:justify-center [.date-picker-header_&]:cursor-pointer [.date-picker-header_&]:[transition:background_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] [.date-picker-header_&]:bg-[var(--surface-subtle)] [.date-picker-header_&]:text-[var(--text-body)] [.date-picker-header_&]:[content:''] [.date-picker-header_&]:absolute [.date-picker-header_&]:top-[50%] [.date-picker-header_&]:left-[50%] [.date-picker-header_&]:w-11 [.date-picker-header_&]:h-11 [.date-picker-header_&]:[transform:translate(-50%,_-50%)]"
              aria-label="关闭筛选"
              onClick={closePanel}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <input
            className="mt-0 mx-[var(--space-3)] mb-[var(--space-2)] min-h-9 py-0 px-[var(--space-2)] border border-solid border-[var(--border-soft)] rounded-[var(--radius-sm,_8px)] bg-[var(--surface-raised)] text-[var(--text-body)] [font:var(--type-body)]"
            type="search"
            placeholder="搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="overflow-y-auto py-0 px-[var(--space-2)] flex-1">
            {!hasOptions ? (
              <p className="text-[var(--text-faint)] [font:var(--type-caption)] py-[var(--space-3)] px-0 text-center">当前范围没有可筛选项目</p>
            ) : visible.length === 0 ? (
              <p className="text-[var(--text-faint)] [font:var(--type-caption)] py-[var(--space-3)] px-0 text-center">没有匹配项</p>
            ) : (
              visible.map((option) => {
                if (option.children && option.children.length > 0) {
                  const childKeys = option.children.map((c) => c.key);
                  const selectedCountInGroup = childKeys.filter((k) => effective.has(k)).length;
                  return (
                    <div key={option.key} className="comp-filter-group">
                      <IndeterminateCheckbox
                        label={option.label}
                        checked={selectedCountInGroup === childKeys.length}
                        indeterminate={selectedCountInGroup > 0 && selectedCountInGroup < childKeys.length}
                        onChange={() => toggleGroup(option)}
                      />
                      <div className="comp-filter-children">
                        {option.children.map((child) => (
                          <IndeterminateCheckbox
                            key={child.key}
                            label={child.label}
                            checked={effective.has(child.key)}
                            indeterminate={false}
                            disabled={child.disabled}
                            onChange={() => toggleLeaf(child.key)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                }
                return (
                  <IndeterminateCheckbox
                    key={option.key}
                    label={option.label}
                    checked={effective.has(option.key)}
                    indeterminate={false}
                    disabled={option.disabled}
                    onChange={() => toggleLeaf(option.key)}
                  />
                );
              })
            )}
          </div>
          <div className="flex justify-between gap-[var(--space-2)] py-[var(--space-2)] px-[var(--space-3)] border-t border-t-[var(--border-soft)] mt-[var(--space-2)] sticky bottom-0 bg-[var(--card)]">
            <button type="button" className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)] bg-transparent border-transparent text-[var(--text-muted)] hover:text-[var(--text-body)]" onClick={onReset}>
              重置
            </button>
            <button type="button" className="inline-flex items-center justify-center gap-1.5 h-[var(--control-height)] py-0 px-3 rounded-[10px] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-body)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] no-underline disabled:opacity-0.5 disabled:cursor-not-allowed hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [&[aria-disabled='true']]:opacity-0.5 [&[aria-disabled='true']]:cursor-not-allowed [.home-chart-toolbar_&]:relative [.home-chart-toolbar_&]:w-auto [.home-chart-toolbar_&]:min-w-[var(--control-height)] [.home-chart-toolbar_&]:h-[var(--control-height)] [.home-chart-toolbar_&]:pointer-events-auto [.home-chart-toolbar_&]:[content:''] [.home-chart-toolbar_&]:absolute [.home-chart-toolbar_&]:top-[50%] [.home-chart-toolbar_&]:left-[50%] [.home-chart-toolbar_&]:w-[max(100%,_var(--touch-target))] [.home-chart-toolbar_&]:h-[var(--touch-target)] [.home-chart-toolbar_&]:[transform:translate(-50%,_-50%)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.balance-sheet-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.income-expense-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.trends-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.transactions-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.alerts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.accounts-page)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:h-[var(--touch-target)] max-md:[body:has(.fx-currency-list)_.app-header-page-actions_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:h-[var(--touch-target)] max-md:[.transactions-page_.transactions-pagination_&]:min-h-[var(--touch-target)] max-md:[.accounts-page_&]:h-[var(--touch-target)] max-md:[.accounts-page_&]:min-h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]" onClick={closePanel}>
              <Check size={14} aria-hidden="true" /> 完成
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
