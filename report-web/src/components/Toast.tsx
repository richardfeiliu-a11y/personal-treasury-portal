import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface ToastItem {
  id: number;
  message: string;
}

interface ToastContextValue {
  showToast: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION_MS = 2500;

/** 全局轻提示：showToast 弹出短暂可见的消息气泡（供 Quick Command 复制等操作反馈）。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const showToast = useCallback((message: string) => {
    const id = ++nextId.current;
    setToasts((prev) => [...prev, { id, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="fixed left-[50%] bottom-6 [transform:translateX(-50%)] z-200 flex flex-col items-center gap-2 pointer-events-none" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className="py-[9px] px-4 rounded-full bg-[var(--surface-inverse)] text-[var(--text-inverse)] text-[13px] font-medium shadow-[0_8px_24px_rgba(0,_0,_0,_0.18)] animate-[toast-in_160ms_var(--ease-standard)]" role="status">
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error("useToast 必须在 ToastProvider 内使用");
  }
  return ctx;
}
