/**
 * CSV 导出（只读端，纯客户端）。
 *
 * 数据来自页面已加载的行，**不新增任何后端请求**，因此不触碰
 * Web Portal = Observe 的只读边界。导出范围是「当前页」，按钮文案
 * 必须如实标注条数——沿用 WP08「本页搜索」的诚实语义：
 * 服务端分页 total 不因导出而被改写或冒充全量。
 *
 * Excel 兼容：写入 UTF-8 BOM，否则中文在 Excel 里显示为乱码。
 */
import type { TransactionRow } from "../api/types";

/** RFC 4180：含分隔符/引号/换行时用双引号包裹，内部引号翻倍。 */
function escapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export const CSV_HEADER = [
  "日期",
  "类型",
  "描述",
  "分类",
  "来源",
  "去向",
  "原币金额",
  "币种",
  "折算金额(CNY)",
  "汇率完整",
  "标签",
  "账目ID",
] as const;

const BOM = "﻿";

export function buildCsv(rows: readonly TransactionRow[]): string {
  const lines: string[] = [CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.date,
        r.type,
        r.description,
        r.category,
        r.source,
        r.destination,
        r.amount_native,
        r.currency,
        // 汇率缺失时 amount_base 为 null：导出空串，绝不写 "null" 文本。
        r.amount_base ?? "",
        r.fx_exact ? "是" : "否",
        r.tags.join(" "),
        r.journal_id,
      ]
        .map((v) => escapeField(String(v ?? "")))
        .join(","),
    );
  }
  return BOM + lines.join("\r\n") + "\r\n";
}

/** 文件名形如 `交易明细_2026-08-01_2026-08-31_100条.csv`。 */
export function buildExportFilename(params: {
  start: string;
  end: string;
  count: number;
}): string {
  return `交易明细_${params.start}_${params.end}_${params.count}条.csv`;
}

export function triggerCsvDownload(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
