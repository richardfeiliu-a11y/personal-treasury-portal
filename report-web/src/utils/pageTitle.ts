import { useEffect } from "react";

/** 页面标题：挂载时设置 "标题 | Personal Treasury"，卸载时恢复原标题。 */
export function usePageTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} | Personal Treasury`;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
