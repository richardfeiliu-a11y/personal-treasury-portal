import { useNavigate } from "react-router-dom";
import { Amount } from "../../components/Amount";
import type { AccountBalanceRow } from "../../api/types";

export function HomeAccounts({
  accounts,
  baseCurrency,
}: {
  accounts: AccountBalanceRow[];
  baseCurrency: string;
}) {
  const navigate = useNavigate();

  const top = accounts
    .filter(
      (a) =>
        (a.type === "asset" ||
          a.type === "liabilities" ||
          a.type === "liability") &&
        a.active,
    )
    .filter((a) => a.balance_base !== null && Number(a.balance_base) > 0)
    .sort((a, b) => Number(b.balance_base) - Number(a.balance_base))
    .slice(0, 6);

  return (
    <section className="adaptive-account-list bg-[var(--card)] border border-solid border-[var(--border-soft)] rounded-xl py-4 px-5" aria-label="账户概览">
      <div className="flex justify-between items-center mb-3">
        <span className="text-[14px] font-semibold text-[var(--text-muted)]">账户概览</span>
        <button
          type="button"
          className="adaptive-account-more text-[12px] text-[var(--primary)] bg-transparent border-0 cursor-pointer hover:underline"
          onClick={() => navigate("/data/accounts")}
        >
          查看全部 →
        </button>
      </div>

      {top.length === 0 ? (
        <p className="adaptive-account-empty text-[13px] text-[var(--text-faint)] text-center py-4 px-0 m-0">暂无账户数据</p>
      ) : (
        <ul className="adaptive-account-items list-none m-0 p-0">
          {top.map((a) => (
            <li key={a.id} className="adaptive-account-item flex justify-between items-center py-2 px-0 border-b border-b-[var(--border-soft)] last:border-b-0">
              <span className="flex flex-col gap-0.5">
                <span className="text-[14px] font-medium text-[var(--text-body)]">{a.name}</span>
                <span className="text-[12px] text-[var(--text-faint)]">
                  {a.group_title ?? "未分组"} · {a.currency}
                </span>
              </span>
              <span className="text-[var(--foreground)] text-[14px] font-semibold [font-variant-numeric:tabular-nums]">
                <Amount value={a.balance_base} currency={baseCurrency} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
