import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { config } from "../config.js";
import { loadUploadedWorkbook, parseWorkbookBuffer } from "./loader.js";

function workbookBuffer(sheets: Record<string, unknown[][]>): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const MAPPING = {
  "LE Mapping": [
    ["Source LE", "Target LE"],
    ["Fund A", "LE-001"],
  ],
};

describe("parseWorkbookBuffer", () => {
  it("parses an .xlsx buffer into sheet documents", () => {
    const loaded = parseWorkbookBuffer(workbookBuffer(MAPPING), "mapping.xlsx");
    expect(loaded.sourceLabel).toBe("mapping.xlsx");
    expect(loaded.sheetCount).toBe(1);
    // Overview card + row document for the single sheet.
    expect(loaded.documents).toHaveLength(2);
    expect(loaded.documents[1].content).toContain("Source LE: Fund A | Target LE: LE-001");
  });

  it("rejects a corrupt .xlsx buffer", () => {
    // SheetJS tolerates plain text (parses it as CSV) but a truncated zip is
    // an unreadable workbook.
    const truncated = workbookBuffer(MAPPING).subarray(0, 200) as Buffer;
    expect(() => parseWorkbookBuffer(truncated, "bad.xlsx")).toThrow();
  });

  it("rejects buffers over MAX_FILE_BYTES", () => {
    const tooBig = Buffer.alloc(config.MAX_FILE_BYTES + 1);
    expect(() => parseWorkbookBuffer(tooBig, "big.xlsx")).toThrow(/too large/);
  });
});

describe("loadUploadedWorkbook", () => {
  it("uses the sanitized originalname as the source label", () => {
    for (const originalname of ["../../etc/mapping.xlsx", "C:\\uploads\\mapping.xlsx"]) {
      const loaded = loadUploadedWorkbook(workbookBuffer(MAPPING), originalname);
      expect(loaded.sourceLabel).toBe("mapping.xlsx");
    }
  });

  it("rejects non-.xlsx uploads", () => {
    expect(() => loadUploadedWorkbook(workbookBuffer(MAPPING), "mapping.csv")).toThrow(/\.xlsx/);
  });
});
