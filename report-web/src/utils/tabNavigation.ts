import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const TABLIST_KEYS = new Set(["ArrowRight", "ArrowLeft", "Home", "End"]);

/**
 * WAI-ARIA Tabs Pattern：在 role="tablist" 容器上处理方向键 / Home / End 的焦点移动。
 * 绑定在 tablist 元素的 onKeyDown 上；焦点按 DOM 顺序在 role="tab" 子项间首尾循环。
 */
export function handleTablistKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
  if (!TABLIST_KEYS.has(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const currentIndex = tabs.indexOf(document.activeElement as HTMLElement);
  if (currentIndex === -1) return;
  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[nextIndex]?.focus();
}

/** pathname 是否位于 to 路由（段级匹配：/reports 不误匹配 /reportsx）。 */
export function isActiveRoute(pathname: string, to: string): boolean {
  if (to === "/") return pathname === "/";
  return pathname === to || pathname.startsWith(`${to}/`);
}
