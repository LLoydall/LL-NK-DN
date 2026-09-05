import { Document } from "@langchain/core/documents";
import { FakeEmbeddings } from "@langchain/core/utils/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuleIndex } from "./store.js";

// Stub the Qdrant client and LangChain vector store so no server is needed.
const mocks = vi.hoisted(() => ({
  getCollections: vi.fn(),
  deleteCollection: vi.fn(),
  count: vi.fn(),
  addDocuments: vi.fn(),
  storeInstances: 0,
}));

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn(() => ({
    getCollections: mocks.getCollections,
    deleteCollection: mocks.deleteCollection,
    count: mocks.count,
  })),
}));

vi.mock("@langchain/qdrant", () => ({
  QdrantVectorStore: vi.fn(() => {
    mocks.storeInstances += 1;
    return { addDocuments: mocks.addDocuments };
  }),
}));

function docs(n: number): Document[] {
  return Array.from({ length: n }, (_, i) => new Document({ pageContent: `chunk ${i}` }));
}

function makeIndex(): RuleIndex {
  return new RuleIndex(new FakeEmbeddings(), {
    url: "http://fake:6333",
    collectionName: "test",
    // Small batches and no pacing keep the batching assertions quick.
    batchSize: 100,
    batchDelayMs: 0,
    maxRetries: 0,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeInstances = 0;
  mocks.getCollections.mockResolvedValue({ collections: [] });
  mocks.count.mockResolvedValue({ count: 0 });
});

describe("RuleIndex.replaceAll", () => {
  it("drops the collection, upserts in batches of 100, and records one source", async () => {
    const index = makeIndex();
    await index.replaceAll(docs(250), "a.xlsx", 3, "test-embedding");

    expect(mocks.getCollections).toHaveBeenCalled();
    expect(mocks.addDocuments).toHaveBeenCalledTimes(3);
    expect(mocks.addDocuments.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 50]);
    expect(index.isReady).toBe(true);
    expect(index.sourcesMetadata).toHaveLength(1);
    expect(index.sourcesMetadata[0]).toMatchObject({
      sourceLabel: "a.xlsx",
      documentCount: 3,
      chunkCount: 250,
    });
  });

  it("deletes the existing collection before upserting", async () => {
    mocks.getCollections.mockResolvedValue({ collections: [{ name: "test" }] });
    const index = makeIndex();
    await index.replaceAll(docs(1), "a.xlsx", 1, "test-embedding");
    expect(mocks.deleteCollection).toHaveBeenCalledWith("test");
  });
});

describe("RuleIndex.addAll", () => {
  it("upserts without dropping the collection and accumulates sources", async () => {
    const index = makeIndex();
    await index.addAll(docs(10), "a.xlsx", 1, "test-embedding");
    await index.addAll(docs(5), "b.xlsx", 2, "test-embedding");

    expect(mocks.deleteCollection).not.toHaveBeenCalled();
    // The store (and its ensureCollection path) is created once, then reused.
    expect(mocks.storeInstances).toBe(1);
    expect(mocks.addDocuments).toHaveBeenCalledTimes(2);
    expect(index.sourcesMetadata.map((m) => m.sourceLabel)).toEqual(["a.xlsx", "b.xlsx"]);
    expect(index.isReady).toBe(true);
  });

  it("is reset by a later replaceAll", async () => {
    const index = makeIndex();
    await index.addAll(docs(10), "a.xlsx", 1, "test-embedding");
    await index.replaceAll(docs(4), "b.xlsx", 1, "test-embedding");

    expect(index.sourcesMetadata.map((m) => m.sourceLabel)).toEqual(["b.xlsx"]);
    // A fresh store is created after the drop.
    expect(mocks.storeInstances).toBe(2);
  });
});

describe("RuleIndex stats and clear", () => {
  it("stats() sums per-source document counts and uses the live chunk count", async () => {
    mocks.count.mockResolvedValue({ count: 15 });
    const index = makeIndex();
    await index.addAll(docs(10), "a.xlsx", 1, "test-embedding");
    await index.addAll(docs(5), "b.xlsx", 2, "test-embedding");

    const stats = await index.stats();
    expect(stats).toEqual({ documentCount: 3, chunkCount: 15 });
  });

  it("clear() drops the collection and wipes sources", async () => {
    mocks.getCollections.mockResolvedValue({ collections: [{ name: "test" }] });
    const index = makeIndex();
    await index.addAll(docs(2), "a.xlsx", 1, "test-embedding");
    await index.clear();

    expect(mocks.deleteCollection).toHaveBeenCalledWith("test");
    expect(index.isReady).toBe(false);
    expect(index.sourcesMetadata).toEqual([]);
  });
});
