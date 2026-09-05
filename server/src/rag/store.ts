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
  /** Chunks per embedding request (Vertex caps at 250 instances). Default 250. */
  batchSize?: number;
  /** Pause between batches to respect requests-per-minute quota. Default 1000. */
  batchDelayMs?: number;
  /** Retries per batch on rate-limit errors (exponential backoff). Default 5. */
  maxRetries?: number;
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

// Quota exhaustion surfaces as a 429 / RESOURCE_EXHAUSTED somewhere in the
// error chain (LangChain wraps the underlying Google error).
function isRateLimitError(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (/429|RESOURCE_EXHAUSTED|rateLimitExceeded|quota exceeded/i.test(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retrieval diversity: over-fetch factor for search() and the maximum number
// of chunks a single sheet may contribute to one answer's context.
const FETCH_MULTIPLIER = 4;
export const MAX_CHUNKS_PER_SHEET = 3;

/**
 * Qdrant-backed vector index for the mapping workbooks. Per-source ingest
 * metadata lives in process memory (single-process hackathon service); the
 * vectors themselves persist in Qdrant, and `clear()`/replace re-ingest
 * recreate the collection so stale points can never leak into answers.
 */
export class RuleIndex {
  private readonly client: QdrantClient;
  private store: QdrantVectorStore | null = null;
  private sources: IndexMetadata[] = [];

  constructor(
    private readonly embeddings: Embeddings,
    private readonly options: RuleIndexOptions,
  ) {
    this.client = new QdrantClient({ url: options.url });
  }

  get isReady(): boolean {
    return this.store !== null && this.sources.length > 0;
  }

  /** Most recently ingested source (used for the chat prompt label). */
  get indexMetadata(): IndexMetadata | null {
    return this.sources[this.sources.length - 1] ?? null;
  }

  /** One entry per ingested file, oldest first. */
  get sourcesMetadata(): readonly IndexMetadata[] {
    return this.sources;
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
      const documentCount =
        this.sources.length > 0
          ? this.sources.reduce((sum, m) => sum + m.documentCount, 0)
          : null;
      return { documentCount, chunkCount: count };
    } catch {
      return null;
    }
  }

  /** Drop the collection, then upsert as the only source. */
  async replaceAll(
    documents: Document[],
    sourceLabel: string,
    documentCount: number,
    embeddingModel: string,
  ): Promise<void> {
    await this.dropCollection();
    // Recreate the store so the first upsert re-runs ensureCollection.
    this.store = null;
    await this.upsertBatches(documents);
    this.sources = [this.sourceMetadata(sourceLabel, documentCount, documents.length, embeddingModel)];
    log("index_replaced", { sourceLabel, documentCount, chunkCount: documents.length });
  }

  /**
   * Append documents alongside the existing corpus (no collection drop).
   * NOTE: appending the same file twice duplicates its chunks — no dedup.
   */
  async addAll(
    documents: Document[],
    sourceLabel: string,
    documentCount: number,
    embeddingModel: string,
  ): Promise<void> {
    await this.upsertBatches(documents);
    this.sources.push(
      this.sourceMetadata(sourceLabel, documentCount, documents.length, embeddingModel),
    );
    log("index_appended", { sourceLabel, documentCount, chunkCount: documents.length });
  }

  private sourceMetadata(
    sourceLabel: string,
    documentCount: number,
    chunkCount: number,
    embeddingModel: string,
  ): IndexMetadata {
    return {
      sourceLabel,
      ingestedAt: new Date().toISOString(),
      documentCount,
      chunkCount,
      embeddingModel,
    };
  }

  private async upsertBatches(documents: Document[]): Promise<void> {
    if (!this.store) {
      this.store = new QdrantVectorStore(this.embeddings, {
        client: this.client,
        collectionName: this.options.collectionName,
      });
    }
    try {
      // First upsert triggers ensureCollection(), which creates the collection
      // with the vector size taken from a probe embedding (Cosine distance).
      // Batches are paced and retried on 429s: lab projects have tiny
      // per-minute request quotas on the embeddings model.
      const batchSize = this.options.batchSize ?? 250;
      const batchDelayMs = this.options.batchDelayMs ?? 1_000;
      const maxRetries = this.options.maxRetries ?? 5;
      for (let i = 0; i < documents.length; i += batchSize) {
        const batch = documents.slice(i, i + batchSize);
        for (let attempt = 0; ; attempt++) {
          try {
            await this.store.addDocuments(batch);
            break;
          } catch (error) {
            if (!isRateLimitError(error) || attempt >= maxRetries) throw error;
            const waitMs = Math.min(60_000, 5_000 * 2 ** attempt);
            log("embed_rate_limited", { attempt: attempt + 1, waitMs });
            await sleep(waitMs);
          }
        }
        log("index_batch_upserted", { done: i + batch.length, total: documents.length });
        if (i + batchSize < documents.length) await sleep(batchDelayMs);
      }
    } catch (error) {
      throw this.wrapUnavailable(error);
    }
  }

  async search(query: string, k: number, minScore: number): Promise<SearchHit[]> {
    if (!this.store) return [];
    let results: [Document, number][];
    try {
      // Over-fetch, then trim for diversity: plain top-k on a corpus with many
      // similar rows returns near-duplicate chunks from a single sheet, which
      // starves the LLM of the cross-section it needs to answer.
      results = await this.store.similaritySearchWithScore(query, k * FETCH_MULTIPLIER);
    } catch (error) {
      throw this.wrapUnavailable(error);
    }
    const seenContent = new Set<string>();
    const perSheet = new Map<string, number>();
    const hits: SearchHit[] = [];
    for (const [document, score] of results) {
      if (score < minScore) continue;
      if (seenContent.has(document.pageContent)) continue;
      const sheet = String(document.metadata.sheet);
      if ((perSheet.get(sheet) ?? 0) >= MAX_CHUNKS_PER_SHEET) continue;
      seenContent.add(document.pageContent);
      perSheet.set(sheet, (perSheet.get(sheet) ?? 0) + 1);
      hits.push({ document, score });
      if (hits.length === k) break;
    }
    return hits;
  }

  async clear(): Promise<void> {
    await this.dropCollection();
    this.store = null;
    this.sources = [];
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
