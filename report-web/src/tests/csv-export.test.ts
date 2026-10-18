import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildCsv,
  buildExportFilename,
  triggerCsvDownload,
} from "../utils/csvExport";
import type { TransactionRow } from "../api/types";

function row(over: Partial<TransactionRow> = {}): TransactionRow {
  return {
    date: "2026-08-01",
    type: "withdrawal",
    description: "咖啡",
    category: "餐饮",
    source: "银行甲存款",
    destination: "咖啡店",
    amount_native: "35.00",
    currency: "CNY",
    amount_base: "35.00",
    fx_exact: true,
    tags: [],
    journal_id: "j1",
    ...over,
  };
}

describe("buildCsv", () => {
  it("输出 UTF-8 BOM，保证 Excel 正确识别中文", () => {
    const csv = buildCsv([row()]);
    expect(csv.startsWith("﻿")).toBe(true);
  });

  it("表头顺序固定且与列数一致", () => {
    const csv = buildCsv([row()]);
    const header = csv.replace(/^﻿/, "").split("\r\n")[0];
    expect(header).toBe(
      "日期,类型,描述,分类,来源,去向,原币金额,币种,折算金额(CNY),汇率完整,标签,账目ID",
    );
  });

  it("逗号、引号、换行按 RFC 4180 转义", () => {
    const csv = buildCsv([
      row({ description: '含,逗号 和"引号"', category: "跨\n行" }),
    ]);
    const body = csv.replace(/^﻿/, "").split("\r\n")[1];
    expect(body).toContain('"含,逗号 和""引号"""');
    expect(body).toContain('"跨\n行"');
  });

  it("amount_base 为 null（汇率缺失）时导出空串而非 null 文本", () => {
    const csv = buildCsv([row({ amount_base: null, fx_exact: false })]);
    const body = csv.replace(/^﻿/, "").split("\r\n")[1];
    expect(body).not.toContain("null");
    expect(body.split(",")[8]).toBe("");
  });

  it("使用 CRLF 换行且空行列表只输出表头", () => {
    expect(buildCsv([]).replace(/^﻿/, "")).toBe(
      "日期,类型,描述,分类,来源,去向,原币金额,币种,折算金额(CNY),汇率完整,标签,账目ID\r\n",
    );
  });

  it("多行数据行数正确", () => {
    const csv = buildCsv([row(), row({ journal_id: "j2" })]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines.filter(Boolean)).toHaveLength(3); // 表头 + 2 行
  });
});

describe("buildExportFilename", () => {
  it("含日期区间与条数，扩展名为 csv", () => {
    const name = buildExportFilename({
      start: "2026-08-01",
      end: "2026-08-31",
      count: 100,
    });
    expect(name).toBe("交易明细_2026-08-01_2026-08-31_100条.csv");
  });

  it("零条时也生成合法文件名", () => {
    const name = buildExportFilename({
      start: "2026-08-01",
      end: "2026-08-31",
      count: 0,
    });
    expect(name).toBe("交易明细_2026-08-01_2026-08-31_0条.csv");
    expect(name).toMatch(/\.csv$/);
  });
});

describe("triggerCsvDownload", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * jsdom 未实现 URL.createObjectURL/revokeObjectURL，直接定义到 URL 上。
   * 用真实 DOM + 监听 <a>.click：不 mock createElement/appendChild，
   * 那会连带劫持 testing-library 的挂载容器。
   */
  function stubDownload() {
    const created: Blob[] = [];
    const downloads: string[] = [];
    const createObjectURL = vi.fn((b: Blob | MediaSource) => {
      created.push(b as Blob);
      return "blob:mock";
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true, writable: true, value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true, writable: true, value: revokeObjectURL,
    });
    // 真实 <a>.click 在 jsdom 下不下载，但属性已挂到实例上，可断言 download 名。
    vi.spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
    return { created, downloads, createObjectURL, revokeObjectURL };
  }

  it("创建 Blob、点击并 revoke URL，文件名落在锚点 download 上", () => {
    const d = stubDownload();

    triggerCsvDownload("a,b\r\n1,2", "test.csv");

    expect(d.createObjectURL).toHaveBeenCalledTimes(1);
    expect(d.downloads).toEqual(["test.csv"]);
    expect(d.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });

  it("Blob 使用 UTF-8 类型，避免 Excel 中文乱码", () => {
    const d = stubDownload();

    triggerCsvDownload("x", "test.csv");

    expect(d.created[0].type).toBe("text/csv;charset=utf-8");
  });

  it("导出后 DOM 不残留下载锚点", () => {
    stubDownload();
    const before = document.body.querySelectorAll("a").length;

    triggerCsvDownload("x", "test.csv");

    expect(document.body.querySelectorAll("a").length).toBe(before);
  });
});
