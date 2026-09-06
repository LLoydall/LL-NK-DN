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
    // Overview card + row document per sheet.
    expect(docs).toHaveLength(4);

    expect(docs[0].metadata).toEqual({ sheet: "LE Mapping", part: 0, category: "mapping" });
    expect(docs[0].content).toContain(
      "Sheet overview: LE Mapping — crosswalk mapping source legal entities to target-system legal entity identifiers",
    );
    expect(docs[0].content).toContain("Rows: 2");
    expect(docs[0].content).toContain("Sample row 1: Source LE: Fund A | Target LE: LE-001");

    expect(docs[1].metadata).toEqual({ sheet: "LE Mapping", part: 1, category: "mapping" });
    expect(docs[1].content).toContain(
      "Sheet: LE Mapping — crosswalk mapping source legal entities to target-system legal entity identifiers (part 1/1)",
    );
    expect(docs[1].content).toContain("Columns: Source LE | Target LE | Notes");
    expect(docs[1].content).toContain("Source LE: Fund A | Target LE: LE-001 | Notes: verified");
    // Empty cells are omitted from the compact row line.
    expect(docs[1].content).toContain("Source LE: Fund B | Target LE: LE-002");

    expect(docs[3].metadata).toEqual({ sheet: "Deal Mapping", part: 1, category: "mapping" });
    expect(docs[3].content).toContain("Source Deal: Deal 1 | Target Deal: D-100");
  });

  it("stamps every document with the ingest-time category", () => {
    const workbook = buildWorkbook({
      "Investor-Level GL": [
        ["Legal Entity", "Amount"],
        ["Fund A", 100],
      ],
    });
    const docs = workbookToDocuments(workbook, "input");
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((d) => d.metadata.category === "input")).toBe(true);
  });

  it("embeds input/output sheets as overview cards only, never raw rows", () => {
    const rows: unknown[][] = [["Legal Entity", "Amount"]];
    for (let i = 0; i < 5_000; i++) {
      rows.push([`Fund ${i}`, i * 10]);
    }
    const workbook = buildWorkbook({ "Investor-Level GL": rows });

    for (const category of ["input", "output"] as const) {
      const docs = workbookToDocuments(workbook, category);
      expect(docs).toHaveLength(1);
      expect(docs[0].metadata).toEqual({ sheet: "Investor-Level GL", part: 0, category });
      expect(docs[0].content).toContain("Columns: Legal Entity | Amount");
      expect(docs[0].content).toContain("Rows: 5000");
      expect(docs[0].content).toContain("Sample row 1: Legal Entity: Fund 0 | Amount: 0");
      // Row data beyond the samples must not be embedded.
      expect(docs[0].content).not.toContain("Fund 4999");
    }
  });

  it("overrides the category for sheets listed in SHEET_CATEGORIES", () => {
    const workbook = buildWorkbook({
      "Upload Template (VERIFIED v4c)": [
        ["Batch ID", "Amount"],
        ["B-1", 10],
      ],
      "LE Mapping": [
        ["Source LE", "Target LE"],
        ["Fund A", "LE-001"],
      ],
    });
    // Ingested as mapping rules, but the template sheet is produced output.
    const docs = workbookToDocuments(workbook, "mapping");
    const template = docs.find((d) => d.metadata.sheet === "Upload Template (VERIFIED v4c)");
    const mapping = docs.find((d) => d.metadata.sheet === "LE Mapping");
    expect(template?.metadata.category).toBe("output");
    expect(mapping?.metadata.category).toBe("mapping");
  });

  it("splits long sheets into numbered parts under ~4k characters", () => {
    const rows: unknown[][] = [["Account", "Target", "Description"]];
    for (let i = 0; i < 300; i++) {
      rows.push([`ACC-${i}`, `TGT-${i}`, `mapping description ${i} with some padding text`]);
    }
    const workbook = buildWorkbook({ "CoA Mapping": rows });
    const docs = workbookToDocuments(workbook);
    expect(docs.length).toBeGreaterThan(2);
    const overviews = docs.filter((d) => d.metadata.part === 0);
    const rowDocs = docs.filter((d) => d.metadata.part > 0);
    expect(overviews).toHaveLength(1);
    expect(rowDocs.map((d) => d.metadata.part)).toEqual(rowDocs.map((_, i) => i + 1));
    for (const doc of rowDocs) {
      expect(doc.metadata.sheet).toBe("CoA Mapping");
      expect(doc.content.length).toBeLessThanOrEqual(4_200);
      expect(doc.content).toContain(`part ${doc.metadata.part}/${rowDocs.length}`);
    }
    // No data row is lost across the split.
    const joined = rowDocs.map((d) => d.content).join("\n");
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
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.metadata.sheet === "LE Mapping")).toBe(true);
  });
});
