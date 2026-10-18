import { NavLink, useLocation } from "react-router-dom";
import { BarChart3, Database, House, TriangleAlert } from "lucide-react";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { handleTablistKeyDown, isActiveRoute } from "../utils/tabNavigation";
import { BASE_MOBILENAVITEM, MOBILENAVITEM_ISACTIVE } from "../utils/legacyClasses";

export const BOTTOM_TABS = [
  { to: "/", label: "首页", icon: House },
  { to: "/reports", label: "报表", icon: BarChart3 },
  { to: "/data", label: "数据", icon: Database },
  { to: "/alerts", label: "提醒", icon: TriangleAlert },
];

export function MobileTabBar() {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const { pathname } = useLocation();

  if (!isMobile) return null;

  return (
    <nav
      className="mobile-nav hidden max-md:flex max-md:fixed max-md:left-0 max-md:right-0 max-md:bottom-0 max-md:z-40 max-md:h-[calc(64px_+_env(safe-area-inset-bottom))] max-md:bg-[var(--topbar-bg)] max-md:[-webkit-backdrop-filter:var(--glass-blur)] max-md:[backdrop-filter:var(--glass-blur)] max-md:border-b max-md:border-b-[var(--glass-border)] max-md:border-t max-md:border-t-[var(--border-default)] max-md:pt-0 max-md:px-2 max-md:pb-[env(safe-area-inset-bottom)] max-md:items-center max-md:justify-around max-md:shadow-[0_-4px_16px_rgba(0,_0,_0,_0.05)] [[data-theme='dark']_&]:bg-[var(--card)] [[data-theme='dark']_&]:border-t-[var(--border-emphasis)] [.app-shell_&]:bg-[var(--glass-solid-fallback)] [.app-shell_&]:backdrop-filter-none"
      aria-label="主导航"
      role="tablist"
      onKeyDown={handleTablistKeyDown}
    >
      {BOTTOM_TABS.map(({ to, label, icon: Icon }) => {
        const isActive = isActiveRoute(pathname, to);
        return (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? "page" : undefined}
            tabIndex={isActive ? 0 : -1}
            className={`${ BASE_MOBILENAVITEM }${ isActive ? ` ${ MOBILENAVITEM_ISACTIVE }` : "" }`}
          >
            <Icon
              size={20}
              aria-hidden="true"
              fill={isActive ? "currentColor" : "none"}
              strokeWidth={isActive ? 2.25 : 2}
            />
            <span>{label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
