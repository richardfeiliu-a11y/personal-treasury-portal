import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * 全局错误边界：捕获路由懒加载 chunk 或页面渲染阶段抛出的错误，
 * 避免"白屏且无人知晓"。渲染失败时展示错误提示 + 刷新按钮，
 * 并把原始错误打到 console.error 便于排查。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 唯一出口：错误必须落到可观测渠道（浏览器控制台 / 日志采集）。
    // 当前项目无 Sentry，至少保证 console.error 可被采集。
    console.error("[ErrorBoundary] 页面渲染失败:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="page error-boundary flex flex-col gap-[var(--space-5)] animate-none max-sm:min-w-0 max-sm:max-w-full max-md:[&_button:not(header_&)]:min-h-[var(--touch-target)] max-md:[&_input]:min-h-[var(--touch-target)] max-md:[&_input]:h-[var(--touch-target)] max-md:[&_select]:min-h-[var(--touch-target)] max-md:[&_select]:h-[var(--touch-target)] grid place-items-center min-h-[60vh] p-[var(--space-4)]" role="alert">
          <div className="banner flex items-start gap-2 py-2.5 px-3 rounded-[10px] border border-solid text-[13px] leading-[20px] font-normal [&_ul]:m-0 [&_ul]:pl-[18px] [.error-boundary_&]:max-w-[560px] [.error-boundary_&_p]:m-0 [.error-boundary_&_button]:ml-[auto] [.error-boundary_&_button]:py-1.5 [.error-boundary_&_button]:px-3 [.error-boundary_&_button]:border [.error-boundary_&_button]:border-solid [.error-boundary_&_button]:border-[var(--danger-600)] [.error-boundary_&_button]:rounded-[8px] [.error-boundary_&_button]:bg-[var(--card)] [.error-boundary_&_button]:text-[var(--danger-700)] [.error-boundary_&_button]:text-[13px] [.error-boundary_&_button]:leading-[20px] [.error-boundary_&_button]:font-semibold [.error-boundary_&_button]:cursor-pointer [.error-boundary_&_button]:whitespace-nowrap bg-[var(--danger-100)] border-[var(--danger-600)] text-[var(--danger-600)]">
            <p>页面加载失败，请刷新重试。若问题持续，请查看浏览器控制台错误信息。</p>
            <button type="button" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}
