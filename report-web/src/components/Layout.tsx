import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
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
  Search,
  Sun,
  TriangleAlert,
  Wallet,
  MoreHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useAnomalies } from "../api/hooks";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { countUndismissedAnomalies } from "../utils/anomalyFilters";
import { getDismissals, SNOOZE_CHANGED_EVENT } from "../utils/snooze";
import { AppHeaderProvider } from "./AppHeader";
import { CommandPalette } from "./CommandPalette";
import { useMask } from "./MaskContext";
import { MobileTabBar } from "./MobileTabBar";
import { ProductSwitcher, type ProductSwitcherHandle } from "./ProductSwitcher";

const THEME_KEY = "pt_theme";

/** 顶栏图标按钮。触控命中区由页面级 max-md 规则补到 44px，控件本体保持 40px。 */
const HEADER_ICON_BTN =
  "home-page-action inline-flex items-center justify-center gap-1.5 h-10 w-10 p-0 rounded-[10px] bg-[var(--topbar-bg)] border border-solid border-[var(--border-default)] text-[var(--text-tertiary)] cursor-pointer hover:bg-[var(--surface-hover)] hover:border-[var(--border-emphasis)] [[data-theme='dark']_&]:bg-[var(--surface-subtle)]";

const NAV_ITEMS = [
  { to: "/", label: "首页", icon: House },
  { to: "/reports/balance-sheet", label: "资产负债", icon: Scale },
  { to: "/reports/income-expense", label: "收支", icon: ArrowLeftRight },
  { to: "/data/accounts", label: "账户", icon: Wallet },
  { to: "/reports/fx", label: "汇率归因", icon: PieChart },
  { to: "/reports/trends", label: "趋势", icon: BarChart3 },
  { to: "/data/transactions", label: "明细", icon: ReceiptText },
  { to: "/alerts", label: "异常", icon: TriangleAlert },
];

function loadTheme(): boolean {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark") return true;
    if (stored === "light") return false;
    // 跟随系统偏好
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function Layout() {
  const { masked, toggleMask } = useMask();
  const location = useLocation();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const productSwitcherRef = useRef<ProductSwitcherHandle>(null);

  // --- 暗黑模式状态 ---
  const [isDark, setIsDark] = useState(loadTheme);
  const toggleTheme = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      try { localStorage.setItem(THEME_KEY, next ? "dark" : "light"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // 同步 data-theme 到 <html>
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  }, [isDark]);

  // --- Command Palette ---
  const [cmdOpen, setCmdOpen] = useState(false);
  const openCmd = useCallback(() => setCmdOpen(true), []);
  const closeCmd = useCallback(() => setCmdOpen(false), []);

  // --- 移动端长按 ProductSwitcher ≥ 600ms (spec v1.2 §5-bis.7) ---
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleProductSwitcherTouchStart = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    longPressStartRef.current = { x: touch.clientX, y: touch.clientY };
    longPressTimerRef.current = setTimeout(() => {
      productSwitcherRef.current?.open();
      longPressTimerRef.current = null;
    }, 600);
  }, []);

  const handleProductSwitcherTouchEnd = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  }, []);

  const handleProductSwitcherTouchMove = useCallback((e: TouchEvent) => {
    if (!longPressStartRef.current) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - longPressStartRef.current.x;
    const dy = touch.clientY - longPressStartRef.current.y;
    // 移动超过 10px 视为滑动操作，取消长按
    if (Math.sqrt(dx * dx + dy * dy) > 10) {
      if (longPressTimerRef.current !== null) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const trigger = document.querySelector<HTMLElement>(".product-switcher-trigger");
    if (!trigger) return;
    trigger.addEventListener("touchstart", handleProductSwitcherTouchStart, { passive: true });
    trigger.addEventListener("touchend", handleProductSwitcherTouchEnd, { passive: true });
    trigger.addEventListener("touchmove", handleProductSwitcherTouchMove, { passive: true });
    return () => {
      trigger.removeEventListener("touchstart", handleProductSwitcherTouchStart);
      trigger.removeEventListener("touchend", handleProductSwitcherTouchEnd);
      trigger.removeEventListener("touchmove", handleProductSwitcherTouchMove);
    };
  }, [isMobile, handleProductSwitcherTouchStart, handleProductSwitcherTouchEnd, handleProductSwitcherTouchMove]);

  // --- 全局快捷键 ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+K / Ctrl+K → Command Palette
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
        return;
      }
      // M → 遮蔽切换（仅在没有输入框聚焦时）
      if (e.key === "m" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
          e.preventDefault();
          toggleMask();
        }
      }
      // D → 暗黑模式切换
      if (e.key === "d" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
          e.preventDefault();
          toggleTheme();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleMask, toggleTheme]);

  // 路由切换时关闭 Command Palette
  useEffect(() => {
    setCmdOpen(false);
  }, [location.pathname]);

  // --- 预加载高频页面 ---
  useEffect(() => {
    const preload = () => {
      import("../pages/BalanceSheet");
      import("../pages/IncomeExpense");
    };
    // Chrome 与 iOS Safari（≥17，owner 确认实机版本）均支持 requestIdleCallback；
    // 旧 Safari fallback 无可达场景（A23 消融删除）。
    requestIdleCallback(preload, { timeout: 3000 });
  }, []);

  const anomaliesQ = useAnomalies();
  // 静音表存 localStorage，Alerts 页写入时不会触发本组件 props/state 变化；
  // 监听 snooze 模块的变更事件，保证侧边栏 badge 与页面操作即时同步。
  const [, setSnoozeVersion] = useState(0);
  useEffect(() => {
    const handler = () => setSnoozeVersion((v) => v + 1);
    window.addEventListener(SNOOZE_CHANGED_EVENT, handler);
    return () => window.removeEventListener(SNOOZE_CHANGED_EVENT, handler);
  }, []);
  const anomalyCount = countUndismissedAnomalies(
    anomaliesQ.data?.anomalies ?? [],
    getDismissals(),
  );

  return (
    <div className="app-shell min-h-screen grid [grid-template-columns:var(--sidebar-width)_minmax(0,_1fr)] [grid-template-rows:var(--topbar-height)_minmax(0,_1fr)] [grid-template-areas:'side_top'_'side_content'] max-[1439px]:[grid-template-columns:var(--sidebar-width-compact)_minmax(0,_1fr)] max-md:[grid-template-columns:1fr] max-md:[grid-template-rows:auto_minmax(0,_1fr)] max-md:[grid-template-areas:'top'_'content'] max-md:[&_main]:pb-[calc(80px_+_env(safe-area-inset-bottom))]">
      <aside className="side-nav [grid-area:side] sticky top-0 h-[100vh] text-[#fff] flex flex-col py-0 px-[var(--space-4)] max-md:hidden [[data-theme='dark']_&]:border-r [[data-theme='dark']_&]:border-r-[var(--border-emphasis)]" style={{ backgroundImage: "var(--sidebar-bg)" }} aria-label="主导航">
        {!isMobile && (
          <div className="side-brand product-switcher-slot flex items-center gap-2.5 h-16 py-0 px-2 border-b border-b-[var(--border-dark)]">
            <ProductSwitcher current="Finance" />
          </div>
        )}
        <nav className="mt-[var(--space-5)] flex flex-col gap-1" aria-label="主导航链接">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `side-nav-item nav-link ${isActive ? "is-active active" : ""}`
              }
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
              {label === "异常" && anomalyCount > 0 && (
                <span className="nav-count-badge ml-[auto] min-w-5 h-5 py-0 px-1.5 rounded-full bg-[var(--danger-100)] text-[var(--danger-700)] text-[11px] leading-[20px] font-semibold text-center">{anomalyCount}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="flex-1" />
      </aside>

      <AppHeaderProvider
        globalActions={
          <>
            {isMobile && (
              <div className="product-switcher-slot mobile-product-switcher hidden max-md:flex max-md:items-center">
                <ProductSwitcher ref={productSwitcherRef} current="Finance" />
              </div>
            )}
            <button
              type="button"
              className={HEADER_ICON_BTN}
              onClick={openCmd}
              aria-label="打开搜索与快捷指令 (⌘K)"
              title="搜索与快捷指令 (⌘K)"
            >
              <Search size={16} />
            </button>
            {isMobile ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={HEADER_ICON_BTN} aria-label="更多操作">
                    <MoreHorizontal size={16} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[10rem]">
                  <DropdownMenuItem onSelect={toggleTheme}>
                    {isDark ? <Sun size={16} /> : <Moon size={16} />}
                    {isDark ? "切换亮色模式" : "切换暗色模式"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={toggleMask}>
                    {masked ? <EyeOff size={16} /> : <Eye size={16} />}
                    {masked ? "显示金额" : "遮蔽全部金额"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <>
                <button
                  type="button"
                  className={HEADER_ICON_BTN}
                  onClick={toggleTheme}
                  aria-label={isDark ? "切换亮色模式" : "切换暗色模式"}
                  title={isDark ? "切换亮色模式 (D)" : "切换暗色模式 (D)"}
                >
                  {isDark ? <Sun size={16} /> : <Moon size={16} />}
                </button>
                <button
                  type="button"
                  className={HEADER_ICON_BTN}
                  onClick={toggleMask}
                  aria-pressed={masked}
                  aria-label={masked ? "显示金额" : "遮蔽全部金额"}
                >
                  {masked ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </>
            )}
          </>
        }
      >
        <main className="content [grid-area:content] w-full min-w-0 bg-[var(--background)] pt-[var(--space-6)] px-[var(--page-padding-x)] pb-[var(--space-12)] max-w-[1440px] justify-self-center max-md:pt-[var(--space-5)] max-md:px-[var(--page-padding-x)] max-md:pb-[var(--space-8)] max-md:pb-[calc(var(--space-8)_+_64px_+_env(safe-area-inset-bottom))] max-md:[.app-shell_&]:pb-[calc(80px_+_env(safe-area-inset-bottom))]">
          <Outlet />
        </main>
      </AppHeaderProvider>

      {/* 移动端 4 核心 Tab 底部导航 (仅 < 768px 渲染) */}
      <MobileTabBar />

      <CommandPalette open={cmdOpen} onClose={closeCmd} toggleTheme={toggleTheme} isDark={isDark} />
    </div>
  );
}
