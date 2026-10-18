// 旧 styles.css 组件类迁移后的 Tailwind 常量。
// 原为一次性迁移脚本生成；其输入是一次性迁移产物，已无法重跑，
// 故本文件自 2026-10-18 起改为手工维护。
// BASE_* 为无条件类；状态常量为条件类，带 important 保证旧级联胜出。

export const BASE_SEGMENTEDITEM =
  'border-0 bg-transparent py-0 px-3 h-[30px] rounded-[8px] [font:500_13px/1_var(--font-family-base)] text-[var(--text-muted)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard),_box-shadow_var(--duration-hover)_var(--ease-standard)] hover:text-[var(--text-body)]';
export const CTX_SEGMENTEDITEM =
  'max-md:[.income-expense-page_&]:h-[var(--touch-target)] max-md:[.income-expense-page_&]:min-h-[var(--touch-target)] max-md:[.transactions-page_&]:h-[var(--touch-target)] max-md:[.transactions-page_&]:min-h-[var(--touch-target)]';
export const SEGMENTEDITEM_ISACTIVE =
  '!bg-[var(--topbar-bg)] !text-[var(--brand-text)] ![-webkit-backdrop-filter:var(--glass-blur)] ![backdrop-filter:var(--glass-blur)] !border-b !border-b-[var(--glass-border)] !shadow-[0_1px_2px_rgba(16,_24,_40,_0.06)]';

export const BASE_TAG =
  'inline-flex items-center h-5 py-0 px-2 rounded-[6px] bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-solid border-[var(--border-subtle)] [font:500_12px/1_var(--font-family-base)]';

export const BASE_HEADLINEDELTA =
  'text-[24px] font-semibold ml-2 max-sm:text-[18px]';

export const BASE_BTNCHIP =
  'inline-flex items-center h-[30px] py-0 px-3 rounded-full bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border border-solid border-[var(--border-default)] text-[var(--text-muted)] [font:500_13px/1_var(--font-family-base)] whitespace-nowrap [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] hover:border-[var(--border-emphasis)] hover:text-[var(--text-body)]';
export const CTX_BTNCHIP =
  'max-md:[.as-of-toolbar_&]:h-[var(--touch-target)] max-md:[.as-of-toolbar_&]:min-h-[var(--touch-target)] [.tab-chip-row_&]:bg-transparent [.tab-chip-row_&]:border [.tab-chip-row_&]:border-solid [.tab-chip-row_&]:border-[var(--border-emphasis)] [.tab-chip-row_&]:text-[var(--text-muted)] [.tab-chip-row_&]:py-1.5 [.tab-chip-row_&]:px-3 [.tab-chip-row_&]:rounded-full [.tab-chip-row_&]:[font:var(--type-label)] [.tab-chip-row_&]:no-underline [.tab-chip-row_&]:[transition:background_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] [.tab-chip-row_&]:bg-[var(--surface-subtle)] [.tab-chip-row_&]:text-[var(--text-body)] [.tab-chip-row_&]:bg-[var(--secondary)] [.tab-chip-row_&]:border-[var(--brand-accent)] [.tab-chip-row_&]:text-[var(--brand-text)] [.tab-chip-row_&]:font-semibold';
export const BTNCHIP_ISACTIVE =
  '!bg-[var(--secondary)] !text-[var(--brand-text)] !border-[var(--brand-accent)]';

export const BASE_DATEPICKERDAY =
  'relative aspect-square rounded-[10px] border border-solid border-transparent bg-transparent text-[var(--text-muted)] [font:var(--type-caption)] font-medium cursor-pointer flex items-center justify-center [transition:background_var(--duration-hover)_var(--ease-standard),_border-color_var(--duration-hover)_var(--ease-standard),_color_var(--duration-hover)_var(--ease-standard)] before:[content:""] before:absolute before:top-[50%] before:left-[50%] before:w-11 before:h-11 before:[transform:translate(-50%,_-50%)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed hover:[&:not(:disabled)]:bg-[var(--surface-subtle)] hover:[&:not(:disabled)]:border-[var(--divider)]';
export const DATEPICKERDAY_ISOUTSIDE =
  '!text-[var(--text-placeholder)]';
export const DATEPICKERDAY_ISSELECTED =
  '!bg-[var(--brand-accent)] !text-[#fff] !border-[var(--brand-accent)]';
export const DATEPICKERDAY_ISTODAY =
  '!text-[var(--brand-text)] !border-[var(--brand-accent)]';

export const BASE_MOBILECARDITEM =
  'bg-[var(--card)] backdrop-filter-none border border-solid border-[var(--border-default)] rounded-xl py-3.5 px-4 flex flex-col gap-2.5 shadow-[var(--shadow-sm)] max-sm:min-w-0 max-sm:max-w-full';
export const MOBILECARDITEM_ISINACTIVE =
  '!opacity-0.7';

export const BASE_MOBILENAVITEM =
  'max-md:flex max-md:flex-col max-md:items-center max-md:justify-center max-md:gap-[3px] max-md:flex-1 max-md:h-full max-md:min-h-[var(--touch-target)] max-md:text-[11px] max-md:leading-[16px] max-md:text-[var(--text-faint)] max-md:no-underline max-md:bg-transparent max-md:border-0 max-md:p-0 max-md:cursor-pointer';
export const MOBILENAVITEM_ISACTIVE =
  'is-active max-md:!text-[var(--brand-text)] max-md:!font-semibold';

export const BASE_BALANCEROW =
  'flex items-center justify-between gap-[var(--space-3)] py-[var(--space-3)] px-0 border-b border-b-[var(--border-soft)] [font:var(--type-body)] last:border-b-0 max-sm:items-start max-sm:gap-0.5 max-sm:flex-col';

export const BASE_PRODUCTSWITCHERCHEVRON =
  'opacity-0.7 [transition:transform_150ms_var(--ease-standard)]';
export const PRODUCTSWITCHERCHEVRON_ISOPEN =
  '![transform:rotate(180deg)]';

export const BASE_PRODUCTSWITCHERITEM =
  'w-full flex items-center gap-2 py-2 px-2.5 rounded-[8px] border-0 bg-transparent text-[var(--text-body)] text-left [font:500_13px/1_var(--font-family-base)] hover:bg-[var(--surface-hover)]';
export const CTX_PRODUCTSWITCHERITEM =
  '[[data-theme="dark"]_&]:bg-[var(--surface-subtle)]';
export const PRODUCTSWITCHERITEM_ISACTIVE =
  '!bg-[var(--brand-tint)] !text-[var(--brand-deep)]';

export const BASE_PERIODTOOLBARERROR =
  'min-h-[18px] m-0 text-transparent [font:var(--type-caption)]';
export const PERIODTOOLBARERROR_ISVISIBLE =
  '!text-[var(--danger-600)]';

export const BASE_COMPFILTERROW =
  'flex items-center gap-[var(--space-2)] min-h-11 py-0 px-[var(--space-2)] rounded-[var(--radius-sm,_8px)] cursor-pointer hover:bg-[var(--surface-hover)] [&_input]:cursor-default';
export const COMPFILTERROW_ISDISABLED =
  '!cursor-default !text-[var(--text-placeholder)] hover:!bg-transparent';

export const BASE_CARD =
  'min-w-0 overflow-hidden bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-card)] p-[var(--card-padding)] [&[data-surface="glass"]]:bg-[var(--glass-bg)] [&[data-surface="glass"]]:[-webkit-backdrop-filter:var(--glass-blur)] [&[data-surface="glass"]]:[backdrop-filter:var(--glass-blur)] [&[data-surface="glass"]]:border-b [&[data-surface="glass"]]:border-b-[var(--glass-border)] [&[data-surface="solid"]]:bg-[var(--glass-solid-fallback)] [&[data-surface="solid"]]:backdrop-filter-none [&[data-surface="solid"]]:border-b [&[data-surface="solid"]]:border-b-[var(--border-default)] [&[data-surface="solid"]]:text-[var(--text-strong)] max-[479px]:p-[var(--card-padding-mobile)] max-[479px]:max-w-full max-sm:max-w-full';
export const CTX_CARD =
  '[.home-page_&]:bg-[var(--card)] [.home-page_&]:backdrop-filter-none [[data-theme="dark"]_&]:bg-[var(--card)] [[data-theme="dark"]_&]:border-[var(--border-emphasis)] [.page_&]:bg-[var(--glass-solid-fallback)] [.page_&]:backdrop-filter-none';

export const BASE_COMPRANKROW =
  'flex items-center gap-[var(--space-2)] w-full min-h-11 py-[var(--space-2)] px-[var(--space-1)] bg-transparent border-0 rounded-[var(--radius-sm,_8px)] text-left no-underline text-inherit [font:var(--type-body)] transition-none cursor-pointer max-sm:min-h-12';
export const CTX_COMPRANKROW =
  '[.comp-rank-zero_&]:text-[var(--text-placeholder)]';

export const BASE_COMPRANKACTIONABLE =
  'hover:bg-[var(--surface-hover)]';

export const BASE_COMPRANKACTIONICON =
  'text-[var(--text-placeholder)] flex-none transition-none';
export const COMPRANKACTIONICON_ISOPEN =
  '![transform:rotate(180deg)]';

export const BASE_BTNFILTERTOGGLE =
  'inline-flex items-center gap-2 bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] text-[var(--text-tertiary)] text-[13px] font-medium py-2 px-3.5 rounded-[10px] cursor-pointer [transition:all_var(--duration-hover)_var(--ease-standard)] hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)]';
export const CTX_BTNFILTERTOGGLE =
  '[[data-theme="dark"]_&]:bg-[var(--surface-subtle)]';
export const BTNFILTERTOGGLE_ISOPEN =
  '!bg-[var(--brand-tint)] !text-[var(--brand-deep)] !border-[var(--brand-border)]';

export const BASE_ANOMALYITEM =
  'flex flex-col gap-2 py-3.5 px-4 bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] border border-solid border-[var(--border-default)] rounded-xl shadow-[var(--shadow-sm)] [transition:all_var(--duration-hover)_var(--ease-standard)]';
export const ANOMALYITEM_ANOMALYCRITICAL =
  '!border-l-[4px] !border-l-solid !border-l-[var(--danger-600)]';
export const ANOMALYITEM_ANOMALYWARNING =
  '!border-l-[4px] !border-l-solid !border-l-[var(--warning-600)]';
export const ANOMALYITEM_ISNEUTRALSURFACE =
  '!bg-[var(--card)] !backdrop-filter-none';

export const BASE_BADGE =
  'inline-flex items-center h-6 py-0 px-2.5 rounded-full bg-[rgba(255,_255,_255,_0.10)] text-[rgba(255,_255,_255,_0.92)] [font:500_12px/1_var(--font-family-base)]';
export const BADGE_ISLIGHT =
  '!bg-[var(--secondary)] !text-[var(--brand-text)]';
export const BADGE_ISNEUTRAL =
  '!bg-[var(--surface-subtle)] !text-[var(--text-muted)]';
export const BADGE_TAGNEGATIVE =
  '!bg-[var(--danger-100)] !text-[var(--danger-700)]';
export const BADGE_TAGNEUTRAL =
  '!bg-[var(--surface-subtle)] !text-[var(--text-muted)]';
export const BADGE_TAGWARNING =
  '!bg-[var(--warning-100)] !text-[var(--warning-800)]';

export const BASE_DELTA =
  '[font:var(--type-caption)] font-medium [font-variant-numeric:tabular-nums]';

export const BASE_TAB =
  'appearance-none border border-solid border-[var(--border-soft)] bg-[var(--card)] text-[var(--text-subtle)] [font:var(--type-caption)] py-1 px-3 rounded-full cursor-pointer min-h-8 max-md:min-h-[var(--touch-target)] focus-visible:outline-[2px_solid_var(--primary-500,_#2F8F68)] focus-visible:outline-offset-[2px] hover:text-[var(--text-body)] hover:border-[var(--border-emphasis)]';
export const CTX_TAB =
  '[[data-theme="dark"]_&]:bg-[var(--surface-inset)] [[data-theme="dark"]_&]:text-[var(--text-inverse)] [[data-theme="dark"]_&]:border-[var(--border-emphasis)]';
// 注：原值还带三个 50/300/700 档的主色 utility，但那三个 CSS 变量在 shadcn.css 中
// 从未定义，声明一直被静默丢弃（与曾修掉的 positive/negative 600 同类问题），实际
// 生效的只有 !font-semibold。2026-10-18 旧 token 迁移时按现状收敛为下面一行，
// 不趁机补色（补色会移动基线）。
export const TAB_ISACTIVE =
  '!font-semibold';
