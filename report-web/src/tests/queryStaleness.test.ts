/**
 * REL-05：`isStaleWhileError` 语义单测。
 *
 * 判定口径（唯一真源，页面不得各自复制）：
 * query 处于「刷新失败但仍持有上一次成功结果」时才算陈旧——
 * isError 为真 **且** data 存在，此时页面渲染的是旧值，必须显式披露。
 * 只有错误、没有任何缓存 → 页面本就没有旧值可展示，不算陈旧。
 */
import { describe, expect, it } from "vitest";
import { isStaleWhileError } from "../utils/queryStaleness";

describe("isStaleWhileError (REL-05)", () => {
  it("error + 已有 data → 判定为陈旧（旧值正被呈现）", () => {
    expect(isStaleWhileError({ isError: true, data: { net_worth_base: "1" } })).toBe(true);
  });

  it("error + data 为 undefined → 不算陈旧（无旧值可误导）", () => {
    expect(isStaleWhileError({ isError: true, data: undefined })).toBe(false);
  });

  it("error + data 为 null → 不算陈旧", () => {
    expect(isStaleWhileError({ isError: true, data: null })).toBe(false);
  });

  it("data + 无 error → 新鲜，不算陈旧", () => {
    expect(isStaleWhileError({ isError: false, data: { rows: [] } })).toBe(false);
  });

  it("falsy data（0 / 空串 / 空数组）仍视为有数据：错误时必须披露", () => {
    expect(isStaleWhileError({ isError: true, data: 0 })).toBe(true);
    expect(isStaleWhileError({ isError: true, data: "" })).toBe(true);
    expect(isStaleWhileError({ isError: true, data: [] })).toBe(true);
  });

  it("query 缺失（undefined / 加载中）不抛错且判为不陈旧", () => {
    expect(isStaleWhileError(undefined)).toBe(false);
    expect(isStaleWhileError(null)).toBe(false);
    expect(isStaleWhileError({})).toBe(false);
  });
});
