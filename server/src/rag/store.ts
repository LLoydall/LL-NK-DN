import { Document } from "@langchain/core/documents";
import type { Embeddings } from "@langchain/core/embeddings";
import { QdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/js-client-rest";
import { log } from "../observability.js";

export class QdrantUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QdrantUnavailableError";
  }
}

export interface IndexMetadata {
  sourceLabel: string;
  ingestedAt: string;
  /** Sheet-part documents produced by ingestion (before chunking). */
  documentCount: number;
  /** Vector chunks upserted at ingest time. */
  chunkCount: number;
  embeddingModel: string;
}

export interface SearchHit {
  document: Document;
  /** Cosine similarity in [-1, 1]; higher is more similar. */
  score: number;
}

export interface RuleIndexOptions {
  url: string;
  collectionName: string;
}

// @qdrant/js-client-rest uses global fetch; an unreachable host surfaces as
// TypeError("fetch failed") with a Node system-error cause.
function isConnectionError(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.message.includes("fetch failed")) return true;
    const code = (current as NodeJS.ErrnoException).code;
    if (code && ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Qdrant-backed vector index for the mapping workbook. Ingest metadata lives
 * in process memory (single-process hackathon service); the vectors
 * themselves persist in Qdrant, and `clear()`/re-ingest recreate the
 * collection so stale points can never leak into answers.
 */
export class RuleIndex {
  private readonly client: QdrantClient;
  private store: QdrantVectorStore | null = null;
  private metadata: IndexMetadata | null = null;

  constructor(
    private readonly embeddings: Embeddings,
    private readonly options: RuleIndexOptions,
  ) {
    this.client = new QdrantClient({ url: options.url });
  }

  get isReady(): boolean {
    return this.store !== null && this.metadata !== null;
  }

  get indexMetadata(): IndexMetadata | null {
    return this.metadata;
  }

  /** Lightweight reachability probe for /api/status. */
  async ping(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  /** Live counts from Qdrant; null when unreachable. */
  async stats(): Promise<{ documentCount: number | null; chunkCount: number } | null> {
    try {
      const { count } = await this.client.count(this.options.collectionName, { exact: true });
      return { documentCount: this.metadata?.documentCount ?? null, chunkCount: count };
    } catch {
      return null;
    }
  }

  async replaceAll(
    documents: Document[],
    sourceLabel: string,
    documentCount: number,
    embeddingModel: string,
  ): Promise<void> {
    await this.dropCollection();
    const store = new QdrantVectorStore(this.embeddings, {
      client: this.client,
      collectionName: this.options.collectionName,
    });
    try {
      // First upsert triggers ensureCollection(), which creates the collection
      // with the vector size taken from a probe embedding (Cosine distance).
      await store.addDocuments(documents);
    } catch (error) {
      throw this.wrapUnavailable(error);
    }
    this.store = store;
    this.metadata = {
      sourceLabel,
      ingestedAt: new Date().toISOString(),
      documentCount,
      chunkCount: documents.length,
      embeddingModel,
    };
    log("index_replaced", { sourceLabel, documentCount, chunkCount: documents.length });
  }

  async search(query: string, k: number, minScore: number): Promise<SearchHit[]> {
    if (!this.store) return [];
    let results: [Document, number][];
    try {
      results = await this.store.similaritySearchWithScore(query, k);
    } catch (error) {
      throw this.wrapUnavailable(error);
    }
    return results
      .map(([document, score]) => ({ document, score }))
      .filter((hit) => hit.score >= minScore);
  }

  async clear(): Promise<void> {
    await this.dropCollection();
    this.store = null;
    this.metadata = null;
    log("index_cleared");
  }

  private async dropCollection(): Promise<void> {
    try {
      const { collections } = await this.client.getCollections();
      if (collections.some((c) => c.name === this.options.collectionName)) {
        await this.client.deleteCollection(this.options.collectionName);
      }
    } catch (error) {
      throw this.wrapUnavailable(error);
    }
  }

  private wrapUnavailable(error: unknown): unknown {
    if (error instanceof QdrantUnavailableError) return error;
    if (isConnectionError(error)) {
      return new QdrantUnavailableError(
        `Qdrant unreachable at ${this.options.url}`,
        { cause: error },
      );
    }
    return error;
  }
}
