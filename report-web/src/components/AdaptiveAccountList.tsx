import { useNavigate } from 'react-router-dom';
import { Amount } from './Amount';
import type { AccountBalanceRow } from '../api/types';

/**
 * Block 7a — AdaptiveAccountList (Spec §7.7)
 * Top accounts, REST data direct output, empty state centered
 */
export function AdaptiveAccountList({
  accounts, baseCurrency,
}: {
  accounts: AccountBalanceRow[];
  baseCurrency: string;
}) {
  const navigate = useNavigate();

  const topAccounts = accounts
    .filter((a) => (a.type === 'asset' || a.type === 'liabilities' || a.type === 'liability') && a.active)
    .filter((a) => a.balance_base !== null && Number(a.balance_base) > 0)
    .sort((a, b) => Number(b.balance_base) - Number(a.balance_base))
    .slice(0, 6);

  if (topAccounts.length === 0) {
    return (
      <section className='adaptive-account-list' aria-label='账户概览'>
        <div className='adaptive-account-header'>
          <span className='adaptive-account-title'>账户概览</span>
        </div>
        <p className='adaptive-account-empty'>暂无账户数据</p>
      </section>
    );
  }

  return (
    <section className='adaptive-account-list' aria-label='账户概览'>
      <div className='adaptive-account-header'>
        <span className='adaptive-account-title'>账户概览</span>
        <button type='button' className='adaptive-account-more' onClick={() => navigate('/accounts')}>查看全部 →</button>
      </div>
      <ul className='adaptive-account-items'>
        {topAccounts.map((a) => (
          <li key={a.id} className='adaptive-account-item'>
            <div className='adaptive-account-info'>
              <span className='adaptive-account-name'>{a.name}</span>
              <span className='adaptive-account-meta'>{a.group_title ?? '未分组'} · {a.currency}</span>
            </div>
            <span className='adaptive-account-amount'>
              <Amount value={a.balance_base} currency={baseCurrency} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
