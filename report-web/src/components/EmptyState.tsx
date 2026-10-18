import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

/** 空状态（spec §13 Empty）：中性图标 + 简短中文说明 + 可选操作。 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state flex flex-col items-center justify-center text-center py-[var(--space-8)] px-[var(--space-4)] text-[var(--text-faint)] [.waterfall-blocked_&]:p-0" role="status">
      <div className="icon" aria-hidden="true">
        {icon ?? <Inbox size={32} />}
      </div>
      <div className="title">{title}</div>
      {description && <div className="desc">{description}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}
