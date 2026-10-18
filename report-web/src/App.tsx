import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Layout } from "./components/Layout";
import { SkeletonBlock, SkeletonCard } from "./components/Skeleton";
import { TabBucketLayout } from "./components/TabBucketLayout";
import { ToastProvider } from "./components/Toast";

const HomePage = lazy(() => import("./features/home/HomePage").then((m) => ({ default: m.HomePage })));
const BalanceSheetPage = lazy(() => import("./pages/BalanceSheet").then((m) => ({ default: m.BalanceSheetPage })));
const IncomeExpensePage = lazy(() => import("./pages/IncomeExpense").then((m) => ({ default: m.IncomeExpensePage })));
const AccountsPage = lazy(() => import("./pages/Accounts").then((m) => ({ default: m.AccountsPage })));
const FxAttributionPage = lazy(() => import("./pages/FxAttribution").then((m) => ({ default: m.FxAttributionPage })));
const TrendsPage = lazy(() => import("./pages/Trends").then((m) => ({ default: m.TrendsPage })));
const TransactionsPage = lazy(() => import("./pages/Transactions").then((m) => ({ default: m.TransactionsPage })));
const AlertsPage = lazy(() => import("./pages/Alerts").then((m) => ({ default: m.AlertsPage })));

function RouteSkeleton() {
  return (
    <div className="page flex flex-col gap-[var(--space-5)] animate-none max-sm:min-w-0 max-sm:max-w-full max-md:[&_button:not(header_&)]:min-h-[var(--touch-target)] max-md:[&_input]:min-h-[var(--touch-target)] max-md:[&_input]:h-[var(--touch-target)] max-md:[&_select]:min-h-[var(--touch-target)] max-md:[&_select]:h-[var(--touch-target)]" aria-label="页面加载中" aria-busy="true">
      <div className="grid [grid-template-columns:repeat(4,_minmax(0,_1fr))] gap-[var(--grid-gap)] max-[1199px]:[grid-template-columns:repeat(2,_minmax(0,_1fr))] max-md:[grid-template-columns:1fr]">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <div className="income-analytics grid [grid-template-columns:minmax(0,_5fr)_minmax(0,_7fr)] gap-[var(--grid-gap)] max-[1199px]:[grid-template-columns:1fr]">
        <SkeletonBlock height={280} />
        <SkeletonBlock height={280} />
      </div>
    </div>
  );
}

function SuspenseRouteOutlet() {
  return (
    <Suspense fallback={<RouteSkeleton />}>
      <Outlet />
    </Suspense>
  );
}

function RedirectWithQuery({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={`${to}${location.search}`} replace />;
}

export function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route element={<SuspenseRouteOutlet />}>
              {/* 首页 (no chip) */}
              <Route index element={<HomePage />} />

              {/* 报表 (chip: 资产负债/收支/趋势/汇率归因) */}
              <Route path="reports" element={<TabBucketLayout bucket="reports" />}>
                <Route index element={<Navigate to="balance-sheet" replace />} />
                <Route path="balance-sheet" element={<BalanceSheetPage />} />
                <Route path="income-expense" element={<IncomeExpensePage />} />
                <Route path="trends" element={<TrendsPage />} />
                <Route path="fx" element={<FxAttributionPage />} />
              </Route>

              {/* 数据 (chip: 账户/明细) */}
              <Route path="data" element={<TabBucketLayout bucket="data" />}>
                <Route index element={<Navigate to="accounts" replace />} />
                <Route path="accounts" element={<AccountsPage />} />
                <Route path="transactions" element={<TransactionsPage />} />
              </Route>

              {/* 提醒 (no chip) */}
              <Route path="alerts" element={<AlertsPage />} />

              {/* 旧 URL 重定向 (按 plan §8 Q1 = A) — 必须放在桶路由之后 */}
              <Route path="balance-sheet" element={<RedirectWithQuery to="/reports/balance-sheet" />} />
              <Route path="income-expense" element={<RedirectWithQuery to="/reports/income-expense" />} />
              <Route path="trends" element={<RedirectWithQuery to="/reports/trends" />} />
              <Route path="fx" element={<RedirectWithQuery to="/reports/fx" />} />
              <Route path="accounts" element={<RedirectWithQuery to="/data/accounts" />} />
              <Route path="transactions" element={<RedirectWithQuery to="/data/transactions" />} />

              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  );
}
