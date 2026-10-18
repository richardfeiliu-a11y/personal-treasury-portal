import { useNavigate } from 'react-router-dom';
import { SignedAmount, Amount } from './Amount';

/**
 * Block 2 — PnlFlowStrip (Spec §7.2, C1 P0)
 * 当月 MTD 4 指标（收入/支出/结余/储蓄率）横条
 * 链接 /income-expense 保留 period，移动端 2x2 grid
 *
 * WP05（U05）：期间由父级显式传入（单一来源），本组件不再自算日期
 * ——原实现用 toISOString()（UTC 日）+ 宿主时区月份，钻取期间可与
 * 首页请求期间漂移。
 */
export function PnlFlowStrip({
  period, income, expenses, netResult, savingsRate, currency,
}: {
  period: { start: string; end: string };
  income: string | null;
  expenses: string | null;
  netResult: string | null;
  savingsRate: string | null;
  currency: string;
}) {
  const navigate = useNavigate();

  const handleNav = () => {
    navigate(`/income-expense?start=${period.start}&end=${period.end}`);
  };

  return (
    <section className='pnl-flow-strip' aria-label='本月收支概览' role='link' tabIndex={0} onClick={handleNav} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleNav(); } }}>
      <div className='pnl-flow-strip-header'>
        <span className='pnl-flow-strip-title'>本月收支</span>
        <span className='pnl-flow-strip-meta'>月至今 · 点击查看详情</span>
      </div>
      <div className='pnl-flow-strip-items'>
        <div className='pnl-flow-item'>
          <span className='pnl-flow-label'>收入</span>
          <span className='pnl-flow-value pnl-flow-income'>
            <Amount value={income} currency={currency} />
          </span>
        </div>
        <div className='pnl-flow-item'>
          <span className='pnl-flow-label'>支出</span>
          <span className='pnl-flow-value pnl-flow-expense'>
            <Amount value={expenses} currency={currency} />
          </span>
        </div>
        <div className='pnl-flow-item'>
          <span className='pnl-flow-label'>结余</span>
          <span className='pnl-flow-value pnl-flow-net'>
            <SignedAmount value={netResult} currency={currency} />
          </span>
        </div>
        <div className='pnl-flow-item'>
          <span className='pnl-flow-label'>储蓄率</span>
          <span className='pnl-flow-value pnl-flow-rate'>
            {savingsRate !== null && savingsRate !== undefined ? `${Number(savingsRate).toFixed(1)}%` : '—'}
          </span>
        </div>
      </div>
    </section>
  );
}
