import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface AppHeaderState {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}

export interface AppHeaderContextValue {
  register: (state: AppHeaderState) => () => void;
}

const AppHeaderContext = createContext<AppHeaderContextValue>({
  register: () => () => {},
});

function AppHeader({
  state,
  globalActions,
}: {
  state: AppHeaderState | null;
  globalActions?: ReactNode;
}) {
  const headerRef = useRef<HTMLElement | null>(null);

  // WP07（U03）：顶栏高度可测量化。日期/操作栏在窄视口换行后实际高度
  // 超过固定 --topbar-height（64px）假设，sticky 子导航与内容起点会重叠。
  // 实测值注入 --topbar-actual-height（消费方：.tab-chip-row 的 sticky top）。
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) {
        document.documentElement.style.setProperty("--topbar-actual-height", `${h}px`);
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <header className="topbar [grid-area:top] sticky top-0 z-30 grid [grid-template-columns:minmax(0,_1fr)_auto] items-center min-h-[var(--topbar-height)] h-auto py-0 px-[var(--page-padding-x)] bg-[var(--topbar-bg)] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] border-b border-b-[var(--glass-border)] [.app-shell_&]:bg-[var(--glass-solid-fallback)] [.app-shell_&]:backdrop-filter-none" ref={headerRef}>
      <div className="min-w-0 flex items-baseline gap-[var(--space-3)] max-md:flex-col max-md:items-start max-md:gap-0">
        {state && <h1 className="topbar-title m-0 [font:var(--type-page-title)] text-[var(--text-strong)] max-md:max-w-full max-md:overflow-hidden max-md:text-ellipsis max-md:whitespace-nowrap">{state.title}</h1>}
        {state?.meta && <div className="topbar-meta inline-flex items-center gap-[var(--space-3)] text-[var(--text-faint)] [font:var(--type-caption)] [.home-analysis-grid_&]:ml-[auto] [.home-analysis-grid_&]:text-right [.home-summary-grid_&]:ml-[auto] [.home-summary-grid_&]:text-right [.home-expense-ranking_&]:ml-[auto] [.home-expense-ranking_&]:text-right min-w-0 overflow-hidden [text-overflow:ellipsis] whitespace-nowrap [&>span]:min-w-0 [&>span]:overflow-hidden [&>span]:[text-overflow:ellipsis] [&>span]:whitespace-nowrap max-[1199px]:leading-[var(--type-caption-line-height,_18px)] max-md:max-w-full max-md:leading-[var(--type-caption-line-height,_18px)]">{state.meta}</div>}
      </div>
      <div className="inline-flex items-center gap-[var(--space-2)] shrink-0 max-md:self-center">
        {state?.actions && (
          <div className="app-header-page-actions inline-flex items-center gap-[var(--space-2)] flex-nowrap">{state.actions}</div>
        )}
        {globalActions}
      </div>
    </header>
  );
}

export function AppHeaderProvider({
  children,
  globalActions,
}: {
  children: ReactNode;
  globalActions?: ReactNode;
}) {
  const [state, setState] = useState<AppHeaderState | null>(null);
  const activeRegistration = useRef<symbol | null>(null);

  const register = useCallback((nextState: AppHeaderState) => {
    const registration = Symbol("app-header");
    activeRegistration.current = registration;
    setState(nextState);

    return () => {
      if (activeRegistration.current === registration) {
        activeRegistration.current = null;
        setState(null);
      }
    };
  }, []);

  const contextValue = useMemo<AppHeaderContextValue>(() => ({ register }), [register]);

  return (
    <AppHeaderContext.Provider value={contextValue}>
      <AppHeader state={state} globalActions={globalActions} />
      {children}
    </AppHeaderContext.Provider>
  );
}

export function useAppHeader(state: AppHeaderState): void {
  const context = useContext(AppHeaderContext);
  useLayoutEffect(
    () => context.register(state),
    [context, state.title, state.meta, state.actions],
  );
}
