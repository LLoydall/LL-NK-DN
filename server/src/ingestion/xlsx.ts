import * as XLSX from "xlsx";

/**
 * Corpus demarcation: every chunk is one of these. `input` is source-system
 * data (e.g. the investor-level GL), `mapping` is the rules/crosswalks that
 * translate input to output, `output` is target-format artifacts (the loader).
 * The point of the tool is explaining how input became output, so retrieval
 * and prompts are category-aware.
 */
export type CorpusCategory = "input" | "mapping" | "output";

export interface SheetDocument {
  content: string;
  metadata: { sheet: string; part: number; category: CorpusCategory };
}

// The upload template holds ~19k loader rows; its retrieval value is the
// column contract, not the row data (row-level checks belong to the engine),
// so it is summarised instead of embedded raw.
const TEMPLATE_SHEET = "Upload Template (VERIFIED v4c)";

// One-line semantic description per known sheet (from the dataset README's
// sheet guide). Embedded with every chunk so retrieval matches what a sheet
// IS, not just the tokens in its rows — e.g. "migration steps" should hit
// Tasks, not Entity Listing rows that happen to contain "migration status".
export const SHEET_DESCRIPTIONS: Record<string, string> = {
  Tasks: "the migration method: the ordered steps used to build the loader, including the batch type override rule",
  "LE Mapping": "crosswalk mapping source legal entities to target-system legal entity identifiers",
  "Investor Mapping": "crosswalk mapping source investor names to target-system investor records",
  "Deal Mapping": "crosswalk mapping source deals and positions to target-system deal/position IDs",
  "CoA Mapping": "crosswalk mapping source chart-of-accounts GL accounts and transaction types to the target chart of accounts",
  "Entity Listing": "legal entities in scope for the migration and their migration status",
  "Deals List": "deal records that must exist in the target system before upload",
  "Investors List": "investor records that must exist in the target system before upload",
  "Suppliers List": "supplier records that must exist in the target system before upload",
  "Corvus CoA": "the target system's full chart of accounts and transaction types",
  "Batch Preference": "batch type override priority order for batches containing several transaction types",
  "Mapping Gaps": "source accounts and transaction types with no target mapping — known gaps pending an administrator decision",
  "Movements Rec": "pre-upload reconciliation of movements per entity per account",
  [TEMPLATE_SHEET]: "the verified loader upload template — the target-system upload file format and columns",
};

/** Sheet name plus its human description, for embedding provenance. */
export function sheetLabel(sheet: string): string {
  const description = SHEET_DESCRIPTIONS[sheet];
  return description ? `${sheet} — ${description}` : sheet;
}

// Per-sheet category overrides (workbook-level category is the default). The
// reference workbook holds both the mapping rules AND the produced loader, so
// its template sheet is output even when the workbook is ingested as mapping.
export const SHEET_CATEGORIES: Record<string, CorpusCategory> = {
  [TEMPLATE_SHEET]: "output",
};

// Soft cap per document so a wide mapping sheet becomes a few focused
// documents rather than one huge one (the chunker refines further).
const MAX_DOC_CHARS = 4_000;

type Row = unknown[];

function sheetRows(sheet: XLSX.WorkSheet): Row[] {
  return XLSX.utils.sheet_to_json<Row>(sheet, {
    header: 1,
    blankrows: false,
    defval: "",
    raw: true,
  });
}

function formatRow(headers: string[], row: Row): string {
  return headers
    .map((header, i) => ({ header, value: row[i] }))
    .filter(({ header, value }) => header !== "" && value !== "" && value != null)
    .map(({ header, value }) => `${header}: ${String(value)}`)
    .join(" | ");
}

function templateSummary(sheet: string, headers: string[], rowCount: number): string {
  return [
    `Sheet: ${sheet}`,
    "Verified loader upload template. Large data sheet: row-level values are",
    "checked deterministically by the engine, not embedded here.",
    `Columns: ${headers.join(" | ")}`,
    `Rows: ${rowCount}`,
  ].join("\n");
}

/** Group row lines into parts that stay under MAX_DOC_CHARS including the header. */
function splitParts(sheet: string, headers: string[], lines: string[]): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  // Reserve space for the two-line header; part count only affects the header
  // text marginally, so a fixed estimate is fine.
  let size = sheet.length + headers.join(" | ").length + 64;
  for (const line of lines) {
    if (current.length > 0 && size + line.length + 1 > MAX_DOC_CHARS) {
      parts.push(current.join("\n"));
      current = [];
      size = sheet.length + headers.join(" | ").length + 64;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) parts.push(current.join("\n"));
  return parts;
}

/**
 * Small topic-dense document per sheet: description + columns + row count +
 * a few sample rows, and nothing else. Bulk row chunks are dominated by
 * account/code tokens, so topical questions ("which accounts have no
 * mapping?") can't rank them above thousands of similar crosswalk rows —
 * the overview card is what makes small-but-important sheets retrievable.
 */
const SAMPLE_ROWS = 3;

function sheetOverview(
  sheet: string,
  headers: string[],
  rowCount: number,
  sampleLines: string[],
): string {
  return [
    `Sheet overview: ${sheetLabel(sheet)}`,
    `Columns: ${headers.join(" | ")}`,
    `Rows: ${rowCount}`,
    ...sampleLines.map((line, i) => `Sample row ${i + 1}: ${line}`),
  ].join("\n");
}

/** Format just the first SAMPLE_ROWS rows of a sheet (data-sheet overviews). */
function sampleRowLines(headers: string[], dataRows: Row[]): string[] {
  return dataRows
    .slice(0, SAMPLE_ROWS)
    .map((row) => formatRow(headers, row))
    .filter((l) => l.length > 0);
}

/**
 * Convert a workbook into retrieval documents: one overview per sheet, plus
 * one or more row documents per sheet, each a header line, the column list,
 * and compact `col: value | col: value` rows. Sheets are split into numbered
 * parts when they exceed ~4k characters. Every document is stamped with its
 * category (workbook-level default, per-sheet override via SHEET_CATEGORIES).
 *
 * Only mapping sheets get row documents. Input/output sheets are DATA (the
 * GL, the loader): tens of thousands of near-identical rows embed slowly,
 * retrieve badly (the per-sheet diversity cap trims them to 3 chunks anyway),
 * and their row-level truth belongs to the engine, not the vector store.
 */
export function workbookToDocuments(
  workbook: XLSX.WorkBook,
  category: CorpusCategory = "mapping",
): SheetDocument[] {
  const documents: SheetDocument[] = [];
  for (const sheet of workbook.SheetNames) {
    const rows = sheetRows(workbook.Sheets[sheet]);
    if (rows.length === 0) continue;
    const headers = rows[0].map((cell) => String(cell ?? ""));
    const dataRows = rows.slice(1);
    const sheetCategory = SHEET_CATEGORIES[sheet] ?? category;

    if (sheet === TEMPLATE_SHEET) {
      documents.push({
        content: templateSummary(sheet, headers, dataRows.length),
        metadata: { sheet, part: 1, category: sheetCategory },
      });
      continue;
    }

    if (sheetCategory !== "mapping") {
      documents.push({
        content: sheetOverview(
          sheet,
          headers,
          dataRows.length,
          sampleRowLines(headers, dataRows),
        ),
        metadata: { sheet, part: 0, category: sheetCategory },
      });
      continue;
    }

    const lines = dataRows.map((row) => formatRow(headers, row)).filter((l) => l.length > 0);
    documents.push({
      content: sheetOverview(sheet, headers, lines.length, lines.slice(0, SAMPLE_ROWS)),
      metadata: { sheet, part: 0, category: sheetCategory },
    });
    const parts = splitParts(sheet, headers, lines);
    parts.forEach((body, i) => {
      documents.push({
        content: [
          `Sheet: ${sheetLabel(sheet)} (part ${i + 1}/${parts.length})`,
          `Columns: ${headers.join(" | ")}`,
          body,
        ].join("\n"),
        metadata: { sheet, part: i + 1, category: sheetCategory },
      });
    });
  }
  return documents;
}
