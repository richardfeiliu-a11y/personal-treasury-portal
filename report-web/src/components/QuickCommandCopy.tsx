import type { ReactNode } from "react";

export interface QuickCommandCopyProps {
  text: string;
  ariaLabel: string;
  title?: string;
  className?: string;
  children: ReactNode;
  onSuccess?: () => void;
  onError?: () => void;
}

/**
 * Copies a Hermes/Feishu follow-up command without performing any write action in Finance.
 * Clipboard API is preferred; the textarea fallback keeps the command usable in older browsers.
 */
export function QuickCommandCopy({
  text,
  ariaLabel,
  title,
  className = "btn-icon-ghost",
  children,
  onSuccess,
  onError,
}: QuickCommandCopyProps) {
  async function copy() {
    // 生产环境为 Chrome / iOS Safari（均支持 async clipboard，站点经 HTTPS 提供）；
    // execCommand 旧浏览器兼容层无可达场景，A22 消融删除。
    try {
      await navigator.clipboard.writeText(text);
      onSuccess?.();
    } catch {
      onError?.();
    }
  }

  return (
    <button type="button" className={className} title={title} aria-label={ariaLabel} onClick={() => void copy()}>
      {children}
    </button>
  );
}
