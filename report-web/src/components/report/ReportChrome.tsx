import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";

/**
 * 报表页共享骨架（第二批迁移）：
 * - PageAnchorNav 顶部锚点导航（sticky，IntersectionObserver 高亮当前分区）；
 * - ReportSection 统一分区卡（标题 / 元信息 / 操作区 / 可折叠）。
 * 数据、hooks、事件一律由调用页保留，本文件只负责呈现节奏。
 */

export interface AnchorItem {
  id: string;
  label: string;
}

/** 顶部锚点条：点击平滑滚动到分区，滚动时自动高亮。 */
export function PageAnchorNav({ items }: { items: AnchorItem[] }) {
  const [active, setActive] = useState<string>(items[0]?.id ?? "");

  useEffect(() => {
    // jsdom 等无 IntersectionObserver 的环境下降级为不高亮（点击仍可用）。
    if (typeof IntersectionObserver === "undefined") return;
    const sections = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -65% 0px", threshold: 0 },
    );
    for (const s of sections) observer.observe(s);
    return () => observer.disconnect();
  }, [items]);

  const go = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    setActive(id);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <nav
      aria-label="分区导航"
      className="sticky top-0 z-20 -mx-1 flex gap-1.5 overflow-x-auto rounded-xl border border-[var(--hairline)] bg-[var(--card)]/90 px-2 py-1.5 shadow-[0_1px_2px_rgba(11,46,39,0.04)] backdrop-blur"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => go(item.id)}
          aria-current={active === item.id ? "true" : undefined}
          className={cn(
            "shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors",
            active === item.id
              ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
              : "text-[var(--text-secondary)] hover:bg-[var(--surface-tint-neutral)] hover:text-[var(--foreground)]",
          )}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

/**
 * 统一分区卡：rounded-xl 白底发丝边 + 标题行；可折叠。
 * `anchorEl` 让锚点定位时不被 sticky header 遮住。
 */
export function ReportSection({
  id,
  title,
  meta,
  actions,
  collapsible = false,
  defaultOpen = true,
  children,
  contentClassName,
}: {
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
  contentClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const wasOpen = useRef(defaultOpen);
  if (open) wasOpen.current = true;

  return (
    <section
      id={id}
      aria-label={typeof title === "string" ? title : undefined}
      className="scroll-mt-20 rounded-xl border border-[var(--hairline)] bg-[var(--card)] shadow-[0_1px_2px_rgba(11,46,39,0.04)]"
    >
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="text-[14.5px] font-semibold tracking-[-0.01em] text-[var(--foreground)]">
            {title}
          </h2>
          {meta && (
            <span className="truncate text-[12px] text-[var(--delta-neutral)]">{meta}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {collapsible && (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? `折叠${String(title)}` : `展开${String(title)}`}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex size-7 items-center justify-center rounded-lg text-[var(--delta-neutral)] transition-colors hover:bg-[var(--surface-tint-neutral)] hover:text-[var(--foreground)]"
            >
              <ChevronDown
                size={16}
                className={cn(
                  "transition-transform duration-200",
                  open ? "" : "-rotate-90",
                )}
              />
            </button>
          )}
        </div>
      </header>
      <div
        className={cn(
          "px-5 pb-5",
          collapsible && !open && "hidden",
          contentClassName,
        )}
      >
        {/* 折叠后保持已挂载内容的状态（曾展开过则不卸载） */}
        {!collapsible || open || wasOpen.current ? children : null}
      </div>
    </section>
  );
}
