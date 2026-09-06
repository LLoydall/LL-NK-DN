import { describe, expect, it } from "vitest";
import { chunkSheetDocuments } from "./chunker.js";
import type { CorpusCategory, SheetDocument } from "./xlsx.js";

function makeDoc(
  sheet: string,
  content: string,
  part = 1,
  category: CorpusCategory = "mapping",
): SheetDocument {
  return { content, metadata: { sheet, part, category } };
}

describe("chunkSheetDocuments", () => {
  it("produces a single chunk for a small sheet document, prefixed with its sheet", async () => {
    const docs = await chunkSheetDocuments([
      makeDoc("LE Mapping", "Sheet: LE Mapping (part 1/1)\nColumns: A | B\nA: 1 | B: 2"),
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0].pageContent).toContain("Sheet: LE Mapping");
    expect(docs[0].pageContent).toContain("A: 1 | B: 2");
    expect(docs[0].metadata).toMatchObject({
      sheet: "LE Mapping",
      part: 1,
      category: "mapping",
      chunkIndex: 0,
    });
  });

  it("splits large sheet documents into multiple ordered chunks", async () => {
    const big = Array.from({ length: 200 }, (_, i) => `Account: ACC${i} | Target: TGT${i}`).join("\n");
    const docs = await chunkSheetDocuments([makeDoc("CoA Mapping", big)]);
    expect(docs.length).toBeGreaterThan(1);
    expect(docs.map((d) => d.metadata.chunkIndex)).toEqual(docs.map((_, i) => i));
    // Every chunk carries provenance.
    for (const doc of docs) {
      expect(doc.pageContent.startsWith("Sheet: CoA Mapping")).toBe(true);
      expect(doc.metadata.sheet).toBe("CoA Mapping");
    }
  });

  it("handles multiple sheets independently", async () => {
    const docs = await chunkSheetDocuments([
      makeDoc("LE Mapping", "Source LE: A | Target LE: B"),
      makeDoc("Deal Mapping", "Source Deal: X | Target Deal: Y", 2),
    ]);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.metadata.sheet)).toEqual(["LE Mapping", "Deal Mapping"]);
    expect(docs[1].metadata.part).toBe(2);
  });

  it("carries the sheet category onto every chunk", async () => {
    const docs = await chunkSheetDocuments([
      makeDoc("Investor-Level GL", "Legal Entity: Fund A | Amount: 100", 1, "input"),
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0].metadata.category).toBe("input");
  });
});
