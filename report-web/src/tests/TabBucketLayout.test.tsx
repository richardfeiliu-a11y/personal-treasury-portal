import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { TabBucketLayout } from '../components/TabBucketLayout';

describe('TabBucketLayout', () => {
  let isMobile = true;

  beforeEach(() => {
    isMobile = true;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: isMobile,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it('移动端下 reports 桶渲染 4 个 chip 并具有正确的 a11y 属性', () => {
    render(
      <MemoryRouter initialEntries={['/reports/balance-sheet']}>
        <Routes>
          <Route path="reports" element={<TabBucketLayout bucket="reports" />}>
            <Route path="balance-sheet" element={<div>Balance Sheet Content</div>} />
            <Route path="income-expense" element={<div>Income Expense Content</div>} />
            <Route path="trends" element={<div>Trends Content</div>} />
            <Route path="fx" element={<div>FX Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    const nav = screen.getByRole('tablist', { name: '报表子导航' });
    expect(nav).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(4);
    expect(tabs[0]).toHaveTextContent('资产负债');
    expect(tabs[1]).toHaveTextContent('收支');
    expect(tabs[2]).toHaveTextContent('趋势');
    expect(tabs[3]).toHaveTextContent('汇率归因');
    expect(screen.getByText('Balance Sheet Content')).toBeInTheDocument();
  });

  it('移动端下 data 桶渲染 2 个 chip', () => {
    render(
      <MemoryRouter initialEntries={['/data/accounts']}>
        <Routes>
          <Route path="data" element={<TabBucketLayout bucket="data" />}>
            <Route path="accounts" element={<div>Accounts Content</div>} />
            <Route path="transactions" element={<div>Transactions Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    const nav = screen.getByRole('tablist', { name: '数据子导航' });
    expect(nav).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('账户');
    expect(tabs[1]).toHaveTextContent('明细');
    expect(screen.getByText('Accounts Content')).toBeInTheDocument();
  });

  it('chip 行支持 WAI-ARIA Tabs 方向键导航与 roving tabindex', () => {
    render(
      <MemoryRouter initialEntries={['/reports/balance-sheet']}>
        <Routes>
          <Route path="reports" element={<TabBucketLayout bucket="reports" />}>
            <Route path="balance-sheet" element={<div>Balance Sheet Content</div>} />
            <Route path="income-expense" element={<div>Income Expense Content</div>} />
            <Route path="trends" element={<div>Trends Content</div>} />
            <Route path="fx" element={<div>FX Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    const nav = screen.getByRole('tablist', { name: '报表子导航' });
    const tabs = screen.getAllByRole('tab');

    // roving tabindex：仅 active chip 可 Tab 到达
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');

    // ArrowRight 移动焦点
    tabs[0].focus();
    fireEvent.keyDown(nav, { key: 'ArrowRight' });
    expect(tabs[1]).toHaveFocus();

    // ArrowLeft 回退
    fireEvent.keyDown(nav, { key: 'ArrowLeft' });
    expect(tabs[0]).toHaveFocus();

    // End 跳到末项，Home 回到首项
    fireEvent.keyDown(nav, { key: 'End' });
    expect(tabs[3]).toHaveFocus();
    fireEvent.keyDown(nav, { key: 'Home' });
    expect(tabs[0]).toHaveFocus();
  });

  it('当前激活的 chip 标记 is-active class', () => {
    render(
      <MemoryRouter initialEntries={['/reports/income-expense']}>
        <Routes>
          <Route path="reports" element={<TabBucketLayout bucket="reports" />}>
            <Route path="balance-sheet" element={<div>Balance Sheet</div>} />
            <Route path="income-expense" element={<div>Income Expense</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    const balanceSheetChip = screen.getByRole('tab', { name: '资产负债' });
    const incomeExpenseChip = screen.getByRole('tab', { name: '收支' });

    expect(balanceSheetChip).not.toHaveClass('is-active');
    expect(incomeExpenseChip).toHaveClass('is-active');
  });

  it('桌面端 (isMobile=false) 不渲染 tab-chip-row 导航', () => {
    isMobile = false;
    render(
      <MemoryRouter initialEntries={['/reports/balance-sheet']}>
        <Routes>
          <Route path="reports" element={<TabBucketLayout bucket="reports" />}>
            <Route path="balance-sheet" element={<div>Balance Sheet Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByText('Balance Sheet Content')).toBeInTheDocument();
  });

  it('chip 的 href 路径包含桶前缀', () => {
    render(
      <MemoryRouter initialEntries={['/reports/trends']}>
        <Routes>
          <Route path="reports" element={<TabBucketLayout bucket="reports" />}>
            <Route path="trends" element={<div>Trends</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    const fxChip = screen.getByRole('tab', { name: '汇率归因' });
    expect(fxChip).toHaveAttribute('href', '/reports/fx');
  });

  it('data 桶 chip 的 href 指向正确子路径', () => {
    render(
      <MemoryRouter initialEntries={['/data/transactions']}>
        <Routes>
          <Route path="data" element={<TabBucketLayout bucket="data" />}>
            <Route path="transactions" element={<div>Transactions</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    const accountsChip = screen.getByRole('tab', { name: '账户' });
    expect(accountsChip).toHaveAttribute('href', '/data/accounts');
    const transactionsChip = screen.getByRole('tab', { name: '明细' });
    expect(transactionsChip).toHaveAttribute('href', '/data/transactions');
    expect(transactionsChip).toHaveClass('is-active');
  });
});
