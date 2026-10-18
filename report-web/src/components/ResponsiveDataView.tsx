import { EmptyState } from "./EmptyState";

export interface ResponsiveDataViewProps {
  isLoading?: boolean;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  loadingSkeleton?: React.ReactNode;
  desktop: React.ReactNode;
  mobile: React.ReactNode;
}

/**
 * 双轨视图容器原语（spec §13 / P1 ResponsiveDataView）：
 * 桌面与移动各渲一条轨道（表格 / 卡片），由外层 CSS 媒体查询控制显隐。
 * 加载与空态优先拦截，避免双轨在无效数据下闪烁。
 */
export function ResponsiveDataView({
  isLoading,
  isEmpty,
  emptyTitle = "暂无数据",
  emptyDescription,
  loadingSkeleton,
  desktop,
  mobile,
}: ResponsiveDataViewProps) {
  if (isLoading) return <>{loadingSkeleton}</>;
  if (isEmpty) return <EmptyState title={emptyTitle} description={emptyDescription} />;

  return (
    <>
      <div className="max-md:hidden">{desktop}</div>
      <div className="hidden max-md:flex max-md:mt-0">{mobile}</div>
    </>
  );
}
