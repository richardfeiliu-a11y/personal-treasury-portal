import { WarningBanner } from "./StatusBanner";
import { hasStaleQuery, type StaleCheckable } from "../utils/queryStaleness";

/**
 * 全站统一的过期文案；「数据可能过期」为 REL-05 规定措辞，页面不得另写一份。
 *
 * 措辞只声明一定成立的部分：横幅出现即说明最近一次刷新失败（isError）且缓存仍有旧值。
 * 不得写「以下为上一次成功获取的结果」——多数页面在错误分支用错误横幅替换了内容，
 * 屏幕上并没有旧值，那样是对用户的事实性错误陈述。
 */
export const STALE_DATA_MESSAGE = "数据可能过期：最近一次刷新失败，请谨慎使用。";

/**
 * REL-05：query 处于 `isError && data`（刷新失败但缓存仍在）时，在页面顶部披露过期风险。
 * 复用 StatusBanner.WarningBanner；判定统一走 isStaleWhileError，多路查询任一陈旧即提示。
 */
export function StaleDataBanner({
  queries,
  onRefresh,
}: {
  queries: readonly (StaleCheckable | null | undefined)[];
  onRefresh?: () => void;
}) {
  if (!hasStaleQuery(queries)) return null;
  return <WarningBanner items={[STALE_DATA_MESSAGE]} onRefresh={onRefresh} testId="stale-data-banner" />;
}
