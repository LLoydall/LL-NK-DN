import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { config } from "../config.js";
import type { SheetDocument } from "./xlsx.js";

/**
 * Chunk sheet documents with the generic recursive splitter (splits on blank
 * lines, then row lines — a good fit for the row-per-line sheet format). Each
 * chunk is prefixed with its sheet name so the embedding captures provenance
 * and the LLM can cite it.
 */
export async function chunkSheetDocuments(sheetDocuments: SheetDocument[]): Promise<Document[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.CHUNK_SIZE,
    chunkOverlap: config.CHUNK_OVERLAP,
  });
  const docs: Document[] = [];
  for (const sheetDoc of sheetDocuments) {
    const chunks = await splitter.splitText(sheetDoc.content);
    chunks.forEach((chunk, index) => {
      docs.push(
        new Document({
          pageContent: `Sheet: ${sheetDoc.metadata.sheet}\n\n${chunk}`,
          metadata: {
            sheet: sheetDoc.metadata.sheet,
            part: sheetDoc.metadata.part,
            chunkIndex: index,
          },
        }),
      );
    });
  }
  return docs;
}
