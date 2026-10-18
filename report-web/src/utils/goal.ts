// 净资产目标：个人偏好，只存浏览器 localStorage，绝不上传服务器（安全边界同 report-web.mask）。
const GOAL_KEY = "report-web.net-worth-goal";

export function getNetWorthGoal(): number | null {
  const raw = window.localStorage.getItem(GOAL_KEY);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function setNetWorthGoal(value: number | null): void {
  if (value === null) {
    window.localStorage.removeItem(GOAL_KEY);
  } else {
    window.localStorage.setItem(GOAL_KEY, String(value));
  }
}
