import { promises as fs } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { config, REPO_ROOT } from "../config.js";
import { workbookToDocuments, type CorpusCategory, type SheetDocument } from "./xlsx.js";

export interface LoadedWorkbook {
  documents: SheetDocument[];
  sheetCount: number;
  sourceLabel: string;
  category: CorpusCategory;
  /** Original workbook bytes (pushed to the engine for pipeline verification). */
  raw: Buffer;
}

/** Shared buffer→documents parsing for both the path and upload flows. */
export function parseWorkbookBuffer(
  buffer: Buffer,
  sourceLabel: string,
  category: CorpusCategory,
): LoadedWorkbook {
  if (buffer.byteLength > config.MAX_FILE_BYTES) {
    throw new Error(
      `Workbook is too large (${buffer.byteLength} bytes > MAX_FILE_BYTES ${config.MAX_FILE_BYTES})`,
    );
  }
  // XLSX.read on a buffer (not readFile) so this works with the ESM build of
  // SheetJS, which doesn't bind fs.
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const documents = workbookToDocuments(workbook, category);
  return { documents, sheetCount: workbook.SheetNames.length, sourceLabel, category, raw: buffer };
}

/**
 * Parse an uploaded workbook (multipart). The client-supplied filename is
 * untrusted, so strip any path parts before using it as the source label.
 */
export function loadUploadedWorkbook(
  buffer: Buffer,
  originalname: string,
  category: CorpusCategory,
): LoadedWorkbook {
  const filename = originalname.split(/[\\/]/).pop() ?? "upload.xlsx";
  if (path.extname(filename).toLowerCase() !== ".xlsx") {
    throw new Error(`Uploaded file must be an .xlsx workbook: ${filename}`);
  }
  return parseWorkbookBuffer(buffer, filename, category);
}

/**
 * Resolve and parse the ingest workbook. The path comes from an HTTP body, so
 * it must stay inside the repo root and point at an .xlsx file.
 */
export async function loadWorkbook(
  inputPath: string,
  category: CorpusCategory,
): Promise<LoadedWorkbook> {
  const resolved = path.resolve(inputPath);
  // path.relative-based containment check; a prefix test breaks when
  // REPO_ROOT is "/" (the container layout resolves it to the fs root).
  const rel = path.relative(REPO_ROOT, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Ingest path must be inside the repository: ${inputPath}`);
  }
  if (path.extname(resolved).toLowerCase() !== ".xlsx") {
    throw new Error(`Ingest path must point to an .xlsx workbook: ${inputPath}`);
  }
  const stat = await fs.stat(resolved);
  if (stat.size > config.MAX_FILE_BYTES) {
    throw new Error(
      `Workbook is too large (${stat.size} bytes > MAX_FILE_BYTES ${config.MAX_FILE_BYTES})`,
    );
  }
  return parseWorkbookBuffer(
    await fs.readFile(resolved),
    path.relative(REPO_ROOT, resolved),
    category,
  );
}
