/**
 * REL-05：查询「陈旧」判定的唯一真源。
 *
 * React Query v5 在 refetch 失败时保留上一次成功的 `data`，此时 `isError` 为真
 * 而页面仍在渲染旧值——必须显式告知用户「数据可能过期」，不得把旧值呈现为最新。
 * 只有错误、没有任何缓存时页面本无旧值可展示，因此不算陈旧。
 *
 * 八个页面共用本判定，禁止在页面里各自复制 `isError && data` 条件。
 */

/** useQuery 结果中判定陈旧所需的最小结构（便于测试与多路查询聚合）。 */
export interface StaleCheckable {
  isError?: boolean;
  data?: unknown;
}

/** query 处于「刷新失败但仍有上一次成功结果」→ 页面显示的是旧值。 */
export function isStaleWhileError(q: StaleCheckable | null | undefined): boolean {
  if (!q) return false;
  return q.isError === true && q.data !== undefined && q.data !== null;
}

/** 多路查询中任一陈旧即为真（首页/收支页等聚合页使用）。 */
export function hasStaleQuery(queries: readonly (StaleCheckable | null | undefined)[]): boolean {
  return queries.some((q) => isStaleWhileError(q));
}
