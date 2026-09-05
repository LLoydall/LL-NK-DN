import * as XLSX from "xlsx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearUploads, uploadData } from "./engineClient.js";
import type { IndexMetadata } from "./rag/store.js";
import { MigrationService } from "./service.js";

// The engine is an external service; mock the client module (keeping the real
// error classes) so no HTTP calls happen.
vi.mock("./engineClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./engineClient.js")>();
  return {
    ...actual,
    checkBatch: vi.fn(),
    clearUploads: vi.fn(async () => {}),
    getOperators: vi.fn(),
    runPipeline: vi.fn(),
    uploadData: vi.fn(async () => ({ ok: true, name: "x.xlsx", bytes: 1 })),
    validateMapping: vi.fn(),
    validatePipeline: vi.fn(),
  };
});

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

/** Workbook with the full reference sheet set (engine crosswalk reload). */
function mappingWorkbookBuffer(): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const sheet of [
    "LE Mapping",
    "Investor Mapping",
    "Deal Mapping",
    "CoA Mapping",
    "Batch Preference",
  ]) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["A", "B"],
        ["x", "y"],
      ]),
      sheet,
    );
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** In-memory stand-in for RuleIndex; no Qdrant or embeddings calls. */
function fakeIndex() {
  const sources: IndexMetadata[] = [];
  return {
    sources,
    addAll: vi.fn(
      async (
        chunks: unknown[],
        sourceLabel: string,
        documentCount: number,
        _embeddingModel: string,
        category: IndexMetadata["category"],
      ) => {
        sources.push({
          sourceLabel,
          category,
          ingestedAt: new Date().toISOString(),
          documentCount,
          chunkCount: chunks.length,
          embeddingModel: "fake",
        });
      },
    ),
    replaceAll: vi.fn(
      async (
        chunks: unknown[],
        sourceLabel: string,
        documentCount: number,
        _embeddingModel: string,
        category: IndexMetadata["category"],
      ) => {
        sources.length = 0;
        sources.push({
          sourceLabel,
          category,
          ingestedAt: new Date().toISOString(),
          documentCount,
          chunkCount: chunks.length,
          embeddingModel: "fake",
        });
      },
    ),
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
    vi.mocked(uploadData).mockClear();
    vi.mocked(clearUploads).mockClear();
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

  it("threads the ingest category into sources and the status summary", async () => {
    const gl = await service.ingest(
      { buffer: workbookBuffer("GL"), originalname: "gl.xlsx" },
      "append",
      "input",
    );
    expect(gl.category).toBe("input");
    await service.ingest({ buffer: workbookBuffer("A"), originalname: "a.xlsx" }, "append");

    const status = await service.status();
    expect(status.sources.map((s) => s.category)).toEqual(["input", "mapping"]);
    expect(status.index?.byCategory.input.sources).toBe(1);
    expect(status.index?.byCategory.mapping.sources).toBe(1);
    expect(status.index?.byCategory.output.sources).toBe(0);
    expect(status.index?.byCategory.input.chunks).toBe(gl.chunkCount);
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

describe("MigrationService engine sync", () => {
  let index: ReturnType<typeof fakeIndex>;
  let service: MigrationService;

  beforeEach(() => {
    index = fakeIndex();
    service = serviceWithIndex(index);
    vi.mocked(uploadData).mockClear();
  });

  it("pushes the workbook to the engine under its basename", async () => {
    const result = await service.ingest(
      { buffer: workbookBuffer("A"), originalname: "uploads/gl.xlsx" },
      "append",
      "input",
    );

    expect(result.engineSync).toBe(true);
    expect(uploadData).toHaveBeenCalledOnce();
    const [name, data, opts] = vi.mocked(uploadData).mock.calls[0];
    expect(name).toBe("gl.xlsx");
    expect(Buffer.isBuffer(data)).toBe(true);
    // Only an LE Mapping sheet — not the full reference set.
    expect(opts).toEqual({ asMapping: false });
  });

  it("asks the engine to reload crosswalks when a full mapping workbook is ingested", async () => {
    await service.ingest(
      { buffer: mappingWorkbookBuffer(), originalname: "mapping.xlsx" },
      "append",
      "mapping",
    );

    expect(vi.mocked(uploadData).mock.calls[0][2]).toEqual({ asMapping: true });
  });

  it("reports engineSync false instead of failing when the engine is down", async () => {
    vi.mocked(uploadData).mockRejectedValueOnce(new Error("engine unreachable"));
    const result = await service.ingest(
      { buffer: workbookBuffer("A"), originalname: "a.xlsx" },
      "append",
    );
    expect(result.engineSync).toBe(false);
  });

  it("clears engine uploads with the index", async () => {
    await service.clearIndex();
    expect(clearUploads).toHaveBeenCalledOnce();
  });
});
