export interface ReturnContext {
  path: string;
  accountName?: string;
  timestamp: number;
}

const KEY = "treasury_return_context";

export function saveReturnContext(ctx: Omit<ReturnContext, "timestamp">): void {
  const full: ReturnContext = { ...ctx, timestamp: Date.now() };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(full));
  } catch {}
}

export function restoreReturnContext(): ReturnContext | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ReturnContext;
  } catch {
    return null;
  }
}

export function clearReturnContext(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
}
