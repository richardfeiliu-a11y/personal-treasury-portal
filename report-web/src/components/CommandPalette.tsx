import { Command } from "cmdk";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeftRight,
  BarChart3,
  Eye,
  EyeOff,
  House,
  Moon,
  PieChart,
  ReceiptText,
  Scale,
  
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { useMask } from "./MaskContext";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  toggleTheme: () => void;
  isDark: boolean;
}

const NAV_ITEMS = [
  // keywords 是 cmdk 过滤时参与匹配的额外词条：value 是英文 slug（用于 onSelect 与路由），
  // 中文 label 不参与默认打分，必须显式加入 keywords 才能让中文检索命中（产品缺陷修复）。
  { value: "home", label: "首页", keywords: ["首页", "主页"], icon: House, shortcut: "G H", to: "/" },
  { value: "balance-sheet", label: "资产负债", keywords: ["资产负债", "资产负债表", "余额"], icon: Scale, shortcut: "G B", to: "/reports/balance-sheet" },
  { value: "income-expense", label: "收支", keywords: ["收支", "收入", "支出"], icon: ArrowLeftRight, shortcut: "G I", to: "/reports/income-expense" },
  { value: "accounts", label: "账户", keywords: ["账户", "账号"], icon: Wallet, shortcut: "G A", to: "/data/accounts" },
  { value: "fx", label: "汇率归因", keywords: ["汇率归因", "汇率", "归因"], icon: PieChart, shortcut: "G F", to: "/reports/fx" },
  { value: "trends", label: "趋势", keywords: ["趋势"], icon: BarChart3, shortcut: "G T", to: "/reports/trends" },
  { value: "transactions", label: "明细", keywords: ["明细", "交易", "流水"], icon: ReceiptText, shortcut: "G X", to: "/data/transactions" },
  { value: "alerts", label: "异常", keywords: ["异常", "告警", "提醒"], icon: TriangleAlert, shortcut: "G L", to: "/alerts" },
];

export function CommandPalette({ open, onClose, toggleTheme, isDark }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { masked, toggleMask } = useMask();
  const inputRef = useRef<HTMLInputElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // 打开时自动聚焦搜索框；关闭后恢复到打开前的控件，避免键盘用户丢失上下文。
  useEffect(() => {
    if (open) {
      previousActiveElementRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }

    const previous = previousActiveElementRef.current;
    if (previous && previous.isConnected) previous.focus();
    previousActiveElementRef.current = null;
  }, [open]);

  if (!open) return null;

  const handleSelect = (value: string) => {
    const nav = NAV_ITEMS.find((n) => n.value === value);
    if (nav) {
      navigate(nav.to);
      onClose();
      return;
    }
    if (value === "toggle-mask") {
      toggleMask();
      onClose();
      return;
    }
    if (value === "toggle-theme") {
      toggleTheme();
      onClose();
      return;
    }
  };

  return createPortal(
    <div
      className="cmd-palette-backdrop fixed inset-0 z-100 bg-[var(--glass-solid-fallback)] backdrop-filter-none flex items-start justify-center pt-[18vh] animate-none [[data-theme='dark']_&]:bg-[rgba(0,_0,_0,_.6)]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <Command
        className="w-full max-w-[560px] bg-[var(--card)] border border-solid border-[var(--border-default)] rounded-[14px] shadow-[var(--shadow-overlay)] overflow-hidden animate-none"
        label="全局搜索与快捷指令"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <Command.Input
          ref={inputRef}
          className="w-full py-[var(--space-4)] px-[var(--space-5)] bg-transparent border-0 border-b border-b-[var(--border-soft)] [font:var(--type-body)] text-[var(--text-body)] outline-none [&::placeholder]:text-[var(--text-placeholder)]"
          placeholder="搜索页面或输入指令…"
        />
        <Command.List className="max-h-[320px] overflow-y-auto p-[var(--space-2)]">
          <Command.Empty className="py-[var(--space-8)] px-[var(--space-4)] text-center text-[var(--text-placeholder)] [font:var(--type-body)]">
            没有匹配结果
          </Command.Empty>

          <Command.Group heading="页面导航" className="py-[var(--space-2)] px-[var(--space-3)] [font:var(--type-caption)] font-semibold text-[var(--text-faint)] uppercase tracking-[0.04em]">
            {NAV_ITEMS.map(({ value, label, keywords, icon: Icon, shortcut }) => (
              <Command.Item
                key={value}
                value={value}
                keywords={keywords}
                className="flex items-center gap-[var(--space-3)] py-[var(--space-2)] px-[var(--space-3)] rounded-[8px] cursor-pointer [font:var(--type-body)] text-[var(--text-body)] [transition:background_var(--duration-hover)_var(--ease-standard)] hover:bg-[var(--surface-subtle)] [&[aria-selected='true']]:bg-[var(--surface-subtle)] [&[data-selected='true']]:bg-[var(--surface-subtle)] [[data-theme='dark']_&]:bg-[var(--surface-inset)]"
                onSelect={handleSelect}
              >
                <Icon size={16} className="text-[var(--text-faint)] shrink-0" aria-hidden="true" />
                <span>{label}</span>
                <span className="cmd-palette-item-shortcut ml-[auto] inline-flex gap-1 [&_kbd]:inline-flex [&_kbd]:items-center [&_kbd]:justify-center [&_kbd]:min-w-[22px] [&_kbd]:h-[22px] [&_kbd]:py-0 [&_kbd]:px-1.5 [&_kbd]:bg-[var(--surface-subtle)] [&_kbd]:border [&_kbd]:border-solid [&_kbd]:border-[var(--border-soft)] [&_kbd]:rounded-[5px] [&_kbd]:[font:600_11px/1_var(--font-family-base)] [&_kbd]:text-[var(--text-subtle)] [[data-theme='dark']_&_kbd]:bg-[var(--surface-inset)] [[data-theme='dark']_&_kbd]:border-[var(--border-emphasis)] [[data-theme='dark']_&_kbd]:text-[var(--text-faint)]">
                  {shortcut.split(" ").map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="快捷指令" className="py-[var(--space-2)] px-[var(--space-3)] [font:var(--type-caption)] font-semibold text-[var(--text-faint)] uppercase tracking-[0.04em]">
            <Command.Item
              value="toggle-mask"
              keywords={["金额", "显示金额", "遮蔽金额", "隐藏金额"]}
              className="flex items-center gap-[var(--space-3)] py-[var(--space-2)] px-[var(--space-3)] rounded-[8px] cursor-pointer [font:var(--type-body)] text-[var(--text-body)] [transition:background_var(--duration-hover)_var(--ease-standard)] hover:bg-[var(--surface-subtle)] [&[aria-selected='true']]:bg-[var(--surface-subtle)] [&[data-selected='true']]:bg-[var(--surface-subtle)] [[data-theme='dark']_&]:bg-[var(--surface-inset)]"
              onSelect={handleSelect}
            >
              {masked
                ? <Eye size={16} className="text-[var(--text-faint)] shrink-0" aria-hidden="true" />
                : <EyeOff size={16} className="text-[var(--text-faint)] shrink-0" aria-hidden="true" />}
              <span>{masked ? "显示金额" : "遮蔽金额"}</span>
              <span className="cmd-palette-item-shortcut ml-[auto] inline-flex gap-1 [&_kbd]:inline-flex [&_kbd]:items-center [&_kbd]:justify-center [&_kbd]:min-w-[22px] [&_kbd]:h-[22px] [&_kbd]:py-0 [&_kbd]:px-1.5 [&_kbd]:bg-[var(--surface-subtle)] [&_kbd]:border [&_kbd]:border-solid [&_kbd]:border-[var(--border-soft)] [&_kbd]:rounded-[5px] [&_kbd]:[font:600_11px/1_var(--font-family-base)] [&_kbd]:text-[var(--text-subtle)] [[data-theme='dark']_&_kbd]:bg-[var(--surface-inset)] [[data-theme='dark']_&_kbd]:border-[var(--border-emphasis)] [[data-theme='dark']_&_kbd]:text-[var(--text-faint)]">
                <kbd>M</kbd>
              </span>
            </Command.Item>
            <Command.Item
              value="toggle-theme"
              keywords={["主题", "暗色", "亮色", "深色", "浅色", "切换暗色模式", "切换亮色模式"]}
              className="flex items-center gap-[var(--space-3)] py-[var(--space-2)] px-[var(--space-3)] rounded-[8px] cursor-pointer [font:var(--type-body)] text-[var(--text-body)] [transition:background_var(--duration-hover)_var(--ease-standard)] hover:bg-[var(--surface-subtle)] [&[aria-selected='true']]:bg-[var(--surface-subtle)] [&[data-selected='true']]:bg-[var(--surface-subtle)] [[data-theme='dark']_&]:bg-[var(--surface-inset)]"
              onSelect={handleSelect}
            >
              <Moon size={16} className="text-[var(--text-faint)] shrink-0" aria-hidden="true" />
              <span>{isDark ? "切换亮色模式" : "切换暗色模式"}</span>
              <span className="cmd-palette-item-shortcut ml-[auto] inline-flex gap-1 [&_kbd]:inline-flex [&_kbd]:items-center [&_kbd]:justify-center [&_kbd]:min-w-[22px] [&_kbd]:h-[22px] [&_kbd]:py-0 [&_kbd]:px-1.5 [&_kbd]:bg-[var(--surface-subtle)] [&_kbd]:border [&_kbd]:border-solid [&_kbd]:border-[var(--border-soft)] [&_kbd]:rounded-[5px] [&_kbd]:[font:600_11px/1_var(--font-family-base)] [&_kbd]:text-[var(--text-subtle)] [[data-theme='dark']_&_kbd]:bg-[var(--surface-inset)] [[data-theme='dark']_&_kbd]:border-[var(--border-emphasis)] [[data-theme='dark']_&_kbd]:text-[var(--text-faint)]">
                <kbd>D</kbd>
              </span>
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>,
    document.body,
  );
}
