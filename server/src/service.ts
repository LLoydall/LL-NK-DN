import { config } from "./config.js";
import { log } from "./observability.js";
import { checkBatch, type EngineCheckResponse } from "./engineClient.js";
import { chunkSheetDocuments } from "./ingestion/chunker.js";
import { loadUploadedWorkbook, loadWorkbook } from "./ingestion/loader.js";
import { RuleIndex } from "./rag/store.js";
import {
  createChatModel,
  createEmbeddings,
  resolvedModelNames,
} from "./rag/models.js";
import {
  buildChatGraph,
  runChat,
  toChatHistory,
  type ChatGraph,
  type ChatResult,
} from "./rag/graph.js";

/**
 * Application service: owns the singleton vector index, chat graph, ingestion
 * pipeline, and the engine client. A class (not module state) so tests can
 * instantiate it with fakes.
 */
export class MigrationService {
  private index: RuleIndex | null = null;
  private graph: ChatGraph | null = null;
  private ingestInFlight: Promise<unknown> | null = null;

  private ensureIndex(): RuleIndex {
    if (!this.index) {
      this.index = new RuleIndex(createEmbeddings(config), {
        url: config.QDRANT_URL,
        collectionName: config.QDRANT_COLLECTION,
        batchSize: config.EMBED_BATCH_SIZE,
        batchDelayMs: config.EMBED_BATCH_DELAY_MS,
        maxRetries: config.EMBED_MAX_RETRIES,
      });
    }
    return this.index;
  }

  private async ensureGraph(): Promise<ChatGraph> {
    if (!this.graph) {
      // Throws MissingCredentialError when ADC is not available.
      const model = await createChatModel(config);
      this.graph = buildChatGraph({ index: this.ensureIndex(), model });
    }
    return this.graph;
  }

  async status() {
    const index = this.ensureIndex();
    const sources = index.sourcesMetadata;
    const reachable = await index.ping();
    const counts = reachable ? await index.stats() : null;
    const latest = sources[sources.length - 1];
    const documentCount = sources.reduce((sum, m) => sum + m.documentCount, 0);
    return {
      ready: sources.length > 0 && reachable,
      models: resolvedModelNames(config),
      qdrant: {
        url: config.QDRANT_URL,
        collection: config.QDRANT_COLLECTION,
        reachable,
      },
      index: latest
        ? {
            sourceLabel:
              sources.length === 1 ? latest.sourceLabel : `${sources.length} sources`,
            documentCount,
            // Live Qdrant count when reachable; fall back to the recorded sum.
            chunkCount:
              counts?.chunkCount ?? sources.reduce((sum, m) => sum + m.chunkCount, 0),
            ingestedAt: latest.ingestedAt,
          }
        : null,
      sources: sources.map(({ sourceLabel, documentCount, chunkCount, ingestedAt }) => ({
        sourceLabel,
        documentCount,
        chunkCount,
        ingestedAt,
      })),
    };
  }

  async ingest(input: IngestInput, mode: IngestMode = "append") {
    // Single-flight ingestion: mutating the index while another ingest runs
    // would interleave embeddings calls and waste quota.
    if (this.ingestInFlight) {
      throw new Error("An ingestion is already in progress. Try again when it finishes.");
    }
    const job = this.doIngest(input, mode).finally(() => {
      this.ingestInFlight = null;
    });
    this.ingestInFlight = job;
    return job;
  }

  private async doIngest(input: IngestInput, mode: IngestMode) {
    const started = Date.now();
    const loaded =
      "path" in input
        ? await loadWorkbook(input.path)
        : loadUploadedWorkbook(input.buffer, input.originalname);
    log("ingest_loaded", {
      source: loaded.sourceLabel,
      sheets: loaded.sheetCount,
      documents: loaded.documents.length,
    });
    if (loaded.documents.length === 0) {
      throw new Error(`No indexable sheet content found in ${loaded.sourceLabel}`);
    }

    const chunks = await chunkSheetDocuments(loaded.documents);
    log("ingest_chunked", { source: loaded.sourceLabel, chunks: chunks.length });

    const index = this.ensureIndex();
    const embeddingModel = resolvedModelNames(config).embeddings;
    if (mode === "replace") {
      await index.replaceAll(chunks, loaded.sourceLabel, loaded.documents.length, embeddingModel);
    } else {
      await index.addAll(chunks, loaded.sourceLabel, loaded.documents.length, embeddingModel);
    }
    const durationMs = Date.now() - started;
    log("ingest_done", { source: loaded.sourceLabel, mode, durationMs });
    return {
      sourceLabel: loaded.sourceLabel,
      documentCount: loaded.documents.length,
      chunkCount: chunks.length,
      durationMs,
      mode,
    };
  }

  async chat(
    question: string,
    history?: Array<{ role: string; content: string }>,
  ): Promise<ChatResult> {
    if (!this.index?.isReady) {
      throw new IndexNotReadyError();
    }
    return runChat(await this.ensureGraph(), question, toChatHistory(history));
  }

  async reviewCheck(payload: unknown): Promise<{ engine: EngineCheckResponse; latencyMs: number }> {
    const started = Date.now();
    const engine = await checkBatch(payload);
    return { engine, latencyMs: Date.now() - started };
  }

  async clearIndex(): Promise<void> {
    if (this.index) await this.index.clear();
  }
}

export class IndexNotReadyError extends Error {
  constructor() {
    super("No workbook has been ingested yet. Ingest a workbook first.");
    this.name = "IndexNotReadyError";
  }
}

export type IngestMode = "append" | "replace";

/** Path flow (dev) or an uploaded workbook buffer (multipart). */
export type IngestInput = { path: string } | { buffer: Buffer; originalname: string };
