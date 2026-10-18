import { saveReturnContext } from "../utils/returnContext";

interface DeepLinkProps {
  label: string;
  accountName: string;
  /** optional custom href base, defaults to "#invest" */
}

export function DeepLink({ label, accountName }: DeepLinkProps) {
  const href = `#invest?account=${encodeURIComponent(accountName)}`;
  const handleClick = () => {
    // Record return context (current path) so ReturnContext can restore
    try {
      saveReturnContext({ path: window.location.pathname + window.location.search, accountName });
    } catch {}
  };
  return (
    <a
      className="inline-flex items-start gap-0.5 text-[var(--primary)] no-underline [font:500_12px/1_var(--font-family-base)] hover:underline hover:underline-offset-[2px] hover:text-[var(--brand-text)]"
      href={href}
      onClick={handleClick}
      aria-label={`${label} 在 Invest 中打开 ${accountName}`}
      data-testid="deep-link-invest"
    >
      <span>{label}</span>
      <span className="mt-px opacity-0.9" aria-hidden="true">↗</span>
    </a>
  );
}
