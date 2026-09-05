import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { workbookToDocuments } from "./xlsx.js";

function buildWorkbook(sheets: Record<string, unknown[][]>): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return workbook;
}

describe("workbookToDocuments", () => {
  it("emits one document per small sheet with headers and compact rows", () => {
    const workbook = buildWorkbook({
      "LE Mapping": [
        ["Source LE", "Target LE", "Notes"],
        ["Fund A", "LE-001", "verified"],
        ["Fund B", "LE-002", ""],
      ],
      "Deal Mapping": [
        ["Source Deal", "Target Deal"],
        ["Deal 1", "D-100"],
      ],
    });
    const docs = workbookToDocuments(workbook);
    expect(docs).toHaveLength(2);

    expect(docs[0].metadata).toEqual({ sheet: "LE Mapping", part: 1 });
    expect(docs[0].content).toContain("Sheet: LE Mapping (part 1/1)");
    expect(docs[0].content).toContain("Columns: Source LE | Target LE | Notes");
    expect(docs[0].content).toContain("Source LE: Fund A | Target LE: LE-001 | Notes: verified");
    // Empty cells are omitted from the compact row line.
    expect(docs[0].content).toContain("Source LE: Fund B | Target LE: LE-002");

    expect(docs[1].metadata).toEqual({ sheet: "Deal Mapping", part: 1 });
    expect(docs[1].content).toContain("Source Deal: Deal 1 | Target Deal: D-100");
  });

  it("splits long sheets into numbered parts under ~4k characters", () => {
    const rows: unknown[][] = [["Account", "Target", "Description"]];
    for (let i = 0; i < 300; i++) {
      rows.push([`ACC-${i}`, `TGT-${i}`, `mapping description ${i} with some padding text`]);
    }
    const workbook = buildWorkbook({ "CoA Mapping": rows });
    const docs = workbookToDocuments(workbook);
    expect(docs.length).toBeGreaterThan(1);
    expect(docs.map((d) => d.metadata.part)).toEqual(docs.map((_, i) => i + 1));
    for (const doc of docs) {
      expect(doc.metadata.sheet).toBe("CoA Mapping");
      expect(doc.content.length).toBeLessThanOrEqual(4_200);
      expect(doc.content).toContain(`part ${doc.metadata.part}/${docs.length}`);
    }
    // No data row is lost across the split.
    const joined = docs.map((d) => d.content).join("\n");
    expect(joined).toContain("ACC-0");
    expect(joined).toContain("ACC-299");
  });

  it("summarises the Upload Template sheet instead of embedding its rows", () => {
    const rows: unknown[][] = [["Batch ID", "Amount", "Account"]];
    for (let i = 0; i < 5_000; i++) {
      rows.push([`B-${i}`, i * 10, `ACC-${i}`]);
    }
    const workbook = buildWorkbook({
      "Upload Template (VERIFIED v4c)": rows,
      "LE Mapping": [
        ["Source LE", "Target LE"],
        ["Fund A", "LE-001"],
      ],
    });
    const docs = workbookToDocuments(workbook);
    const templateDocs = docs.filter((d) => d.metadata.sheet === "Upload Template (VERIFIED v4c)");
    expect(templateDocs).toHaveLength(1);
    expect(templateDocs[0].content).toContain("Columns: Batch ID | Amount | Account");
    expect(templateDocs[0].content).toContain("Rows: 5000");
    // Raw row values must not be embedded.
    expect(templateDocs[0].content).not.toContain("B-4999");
    // Other sheets are unaffected.
    expect(docs.some((d) => d.metadata.sheet === "LE Mapping")).toBe(true);
  });

  it("skips sheets with no rows at all", () => {
    const workbook = buildWorkbook({
      "LE Mapping": [
        ["Source LE", "Target LE"],
        ["Fund A", "LE-001"],
      ],
    });
    // An empty sheet added manually (aoa_to_sheet of [] yields no !ref).
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), "Empty Sheet");
    const docs = workbookToDocuments(workbook);
    expect(docs).toHaveLength(1);
    expect(docs[0].metadata.sheet).toBe("LE Mapping");
  });
});
