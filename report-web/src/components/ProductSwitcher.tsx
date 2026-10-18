import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronDown } from "lucide-react";
import { BASE_PRODUCTSWITCHERCHEVRON, BASE_PRODUCTSWITCHERITEM, PRODUCTSWITCHERCHEVRON_ISOPEN, PRODUCTSWITCHERITEM_ISACTIVE } from "../utils/legacyClasses";

type Product = "Finance" | "Invest";

export interface ProductSwitcherProps {
  current?: Product;
}

export interface ProductSwitcherHandle {
  open: () => void;
}

export const ProductSwitcher = forwardRef<ProductSwitcherHandle, ProductSwitcherProps>(
  function ProductSwitcher({ current = "Finance" }, ref) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    useImperativeHandle(ref, () => ({
      open: () => setOpen(true),
    }), []);

    const close = useCallback(() => setOpen(false), []);
    const toggle = useCallback(() => setOpen((v) => !v), []);

    // Outside click & Esc
    useEffect(() => {
      if (!open) return;
      const onClick = (e: MouseEvent) => {
        if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") close();
      };
      document.addEventListener("mousedown", onClick);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onClick);
        document.removeEventListener("keydown", onKey);
      };
    }, [open, close]);

    // Keyboard shortcuts ⌘1 / ⌘2（ALIGN-01：切换语义为导航；本仓库仅 Finance，
    // Invest 目标尚不存在，故动作仅为关闭菜单）
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if (!e.metaKey || e.altKey || e.ctrlKey) return;
        if (e.key === "1" || e.key === "2") {
          // Only act when not in input
          const tag = (e.target as HTMLElement).tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
          e.preventDefault();
          close();
        }
      };
      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }, [close]);

    useEffect(() => {
      if (!open) return;
      rootRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    }, [open]);

    const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']"));
      const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);

      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;

      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[nextIndex]?.focus();
    };

    const selectProduct = (_p: Product) => {
      close();
    };

    return (
      <div className="relative" ref={rootRef} data-testid="product-switcher">
        <button
          ref={triggerRef}
          type="button"
          className="product-switcher-trigger inline-flex items-center gap-2 h-8 py-0 px-2.5 rounded-[8px] bg-transparent border border-solid border-[rgba(255,255,255,0.12)] text-[#fff] [font:600_13px/1_var(--font-family-base)] hover:bg-[rgba(255,255,255,0.08)] max-md:[.mobile-product-switcher_&]:border-[var(--border-default)] max-md:[.mobile-product-switcher_&]:text-[var(--text-body)] max-md:[.mobile-product-switcher_&]:bg-[var(--topbar-bg)] max-md:[.mobile-product-switcher_&]:bg-[var(--surface-subtle)]"
          aria-label="Treasury 工作区切换器"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={toggle}
        >
          <span className="brand-mark w-[22px] h-[22px] rounded-[6px] inline-flex items-center justify-center bg-[linear-gradient(135deg,_var(--primary),_var(--brand-deep))] [font:800_10px/1_var(--font-family-base)] text-[#fff]" aria-hidden="true">M</span>
          <span className="product-switcher-label tracking-[0.02em] max-md:sr-only">Treasury {current}</span>
          <ChevronDown size={14} className={`${ BASE_PRODUCTSWITCHERCHEVRON }${ open ? ` ${ PRODUCTSWITCHERCHEVRON_ISOPEN }` : "" }`} aria-hidden="true" />
        </button>
        {open && (
          <div className="absolute top-[calc(100%_+_8px)] left-0 min-w-[220px] p-1.5 bg-[var(--card)] border border-solid border-[var(--border-default)] rounded-[10px] shadow-[var(--shadow-family-overlay)] z-50" role="menu" aria-label="工作区切换" onKeyDown={handleMenuKeyDown}>
            <span className="sr-only" aria-live="polite">切换 Treasury 工作区</span>
            <button
              type="button"
              role="menuitem"
              className={`${ BASE_PRODUCTSWITCHERITEM }${ current === "Finance" ? ` ${ PRODUCTSWITCHERITEM_ISACTIVE }` : "" }`}
              aria-current={current === "Finance" ? "page" : undefined}
              onClick={() => selectProduct("Finance")}
            >
              <span className="w-5 h-5 rounded-[6px] inline-flex items-center justify-center bg-[var(--surface-subtle)] [font:700_10px/1_var(--font-family-base)]">F</span>
              <span>Treasury Finance</span>
              <span className="ml-[auto] [font:400_11px/1_var(--font-family-mono)] text-[var(--text-faint)]">⌘1</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${ BASE_PRODUCTSWITCHERITEM }${ current === "Invest" ? ` ${ PRODUCTSWITCHERITEM_ISACTIVE }` : "" }`}
              aria-current={current === "Invest" ? "page" : undefined}
              onClick={() => selectProduct("Invest")}
            >
              <span className="w-5 h-5 rounded-[6px] inline-flex items-center justify-center bg-[var(--surface-subtle)] [font:700_10px/1_var(--font-family-base)]">I</span>
              <span>Treasury Invest</span>
              <span className="ml-[auto] [font:400_11px/1_var(--font-family-mono)] text-[var(--text-faint)]">⌘2</span>
            </button>
          </div>
        )}
      </div>
    );
  }
);
