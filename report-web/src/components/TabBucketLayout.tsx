import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { handleTablistKeyDown, isActiveRoute } from '../utils/tabNavigation';
import { BASE_BTNCHIP, BTNCHIP_ISACTIVE } from "../utils/legacyClasses";

type Bucket = 'reports' | 'data';

const CHIPS: Record<Bucket, { to: string; label: string }[]> = {
  reports: [
    { to: 'balance-sheet', label: '资产负债' },
    { to: 'income-expense', label: '收支' },
    { to: 'trends', label: '趋势' },
    { to: 'fx', label: '汇率归因' },
  ],
  data: [
    { to: 'accounts', label: '账户' },
    { to: 'transactions', label: '明细' },
  ],
};

export function TabBucketLayout({ bucket }: { bucket: Bucket }) {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const { pathname } = useLocation();
  const chips = CHIPS[bucket];
  const prefix = `/${bucket}/`;
  const ariaLabel = bucket === 'reports' ? '报表子导航' : '数据子导航';
  return (
    <>
      {isMobile && (
        <nav
          className="tab-chip-row flex flex-wrap gap-[var(--space-2)] py-[var(--space-3)] px-[var(--page-padding-x)] bg-[var(--background)] border-b border-b-[var(--border-soft)] sticky top-[var(--topbar-actual-height,_var(--topbar-height))] z-5"
          aria-label={ariaLabel}
          role="tablist"
          onKeyDown={handleTablistKeyDown}
        >
          {chips.map((c) => {
            const to = `${prefix}${c.to}`;
            const isActive = isActiveRoute(pathname, to);
            return (
              <NavLink
                key={c.to}
                to={to}
                role="tab"
                aria-selected={isActive}
                aria-current={isActive ? 'page' : undefined}
                tabIndex={isActive ? 0 : -1}
                className={`${ BASE_BTNCHIP }${ isActive ? ` is-active ${ BTNCHIP_ISACTIVE }` : "" }`}
              >
                {c.label}
              </NavLink>
            );
          })}
        </nav>
      )}
      <Outlet />
    </>
  );
}
