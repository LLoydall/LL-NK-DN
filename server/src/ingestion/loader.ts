import { promises as fs } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { config, REPO_ROOT } from "../config.js";
import { workbookToDocuments, type SheetDocument } from "./xlsx.js";

export interface LoadedWorkbook {
  documents: SheetDocument[];
  sheetCount: number;
  sourceLabel: string;
}

/**
 * Resolve and parse the ingest workbook. The path comes from an HTTP body, so
 * it must stay inside the repo root and point at an .xlsx file.
 */
export async function loadWorkbook(inputPath: string): Promise<LoadedWorkbook> {
  const resolved = path.resolve(inputPath);
  if (resolved !== REPO_ROOT && !resolved.startsWith(REPO_ROOT + path.sep)) {
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
  // XLSX.read on a buffer (not readFile) so this works with the ESM build of
  // SheetJS, which doesn't bind fs.
  const workbook = XLSX.read(await fs.readFile(resolved), { type: "buffer" });
  const documents = workbookToDocuments(workbook);
  return {
    documents,
    sheetCount: workbook.SheetNames.length,
    sourceLabel: path.relative(REPO_ROOT, resolved),
  };
}
