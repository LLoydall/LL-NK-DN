import * as XLSX from "xlsx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexMetadata } from "./rag/store.js";
import { MigrationService } from "./service.js";

function workbookBuffer(name: string): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Source LE", "Target LE"],
      [`Fund ${name}`, "LE-001"],
    ]),
    "LE Mapping",
  );
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** In-memory stand-in for RuleIndex; no Qdrant or embeddings calls. */
function fakeIndex() {
  const sources: IndexMetadata[] = [];
  return {
    sources,
    addAll: vi.fn(async (chunks: unknown[], sourceLabel: string, documentCount: number) => {
      sources.push({
        sourceLabel,
        ingestedAt: new Date().toISOString(),
        documentCount,
        chunkCount: chunks.length,
        embeddingModel: "fake",
      });
    }),
    replaceAll: vi.fn(async (chunks: unknown[], sourceLabel: string, documentCount: number) => {
      sources.length = 0;
      sources.push({
        sourceLabel,
        ingestedAt: new Date().toISOString(),
        documentCount,
        chunkCount: chunks.length,
        embeddingModel: "fake",
      });
    }),
    ping: vi.fn(async () => true),
    stats: vi.fn(async () => ({
      documentCount: sources.reduce((sum, m) => sum + m.documentCount, 0),
      chunkCount: sources.reduce((sum, m) => sum + m.chunkCount, 0),
    })),
    clear: vi.fn(async () => {
      sources.length = 0;
    }),
    get isReady() {
      return sources.length > 0;
    },
    get sourcesMetadata() {
      return sources;
    },
  };
}

function serviceWithIndex(index: ReturnType<typeof fakeIndex>): MigrationService {
  const service = new MigrationService();
  // Inject the fake so no embeddings/Qdrant clients are constructed.
  (service as unknown as { index: unknown }).index = index;
  return service;
}

describe("MigrationService ingest modes", () => {
  let index: ReturnType<typeof fakeIndex>;
  let service: MigrationService;

  beforeEach(() => {
    index = fakeIndex();
    service = serviceWithIndex(index);
  });

  it("append mode accumulates sources across two ingests", async () => {
    const first = await service.ingest(
      { buffer: workbookBuffer("A"), originalname: "a.xlsx" },
      "append",
    );
    const second = await service.ingest(
      { buffer: workbookBuffer("B"), originalname: "b.xlsx" },
      "append",
    );

    expect(index.replaceAll).not.toHaveBeenCalled();
    expect(first.mode).toBe("append");
    expect(second.sourceLabel).toBe("b.xlsx");
    expect(first.chunkCount).toBeGreaterThan(0);

    const status = await service.status();
    expect(status.ready).toBe(true);
    expect(status.sources.map((s) => s.sourceLabel)).toEqual(["a.xlsx", "b.xlsx"]);
    expect(status.index?.sourceLabel).toBe("2 sources");
    // Each single-sheet workbook yields an overview card + one row document.
    expect(status.index?.documentCount).toBe(4);
    expect(status.index?.chunkCount).toBe(first.chunkCount + second.chunkCount);
    expect(status.index?.ingestedAt).toBe(status.sources[1].ingestedAt);
  });

  it("replace mode routes to replaceAll and collapses sources", async () => {
    await service.ingest({ buffer: workbookBuffer("A"), originalname: "a.xlsx" }, "append");
    const result = await service.ingest(
      { buffer: workbookBuffer("B"), originalname: "b.xlsx" },
      "replace",
    );

    expect(result.mode).toBe("replace");
    expect(index.replaceAll).toHaveBeenCalledOnce();
    const status = await service.status();
    expect(status.sources.map((s) => s.sourceLabel)).toEqual(["b.xlsx"]);
    expect(status.index?.sourceLabel).toBe("b.xlsx");
  });

  it("reports an empty corpus when nothing is ingested", async () => {
    const status = await service.status();
    expect(status.ready).toBe(false);
    expect(status.index).toBeNull();
    expect(status.sources).toEqual([]);
  });

  it("rejects a concurrent ingest while one is in flight", async () => {
    let release!: () => void;
    index.addAll.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = service.ingest({ buffer: workbookBuffer("A"), originalname: "a.xlsx" }, "append");
    // Wait until the first ingest actually holds the index before contending.
    await vi.waitUntil(() => index.addAll.mock.calls.length > 0);
    await expect(
      service.ingest({ buffer: workbookBuffer("B"), originalname: "b.xlsx" }, "append"),
    ).rejects.toThrow(/already in progress/);
    release();
    await first;
  });
});
