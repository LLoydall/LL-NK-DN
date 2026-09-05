import { config } from "./config.js";
import { log } from "./observability.js";
import { checkBatch, type EngineCheckResponse } from "./engineClient.js";
import { chunkSheetDocuments } from "./ingestion/chunker.js";
import { loadWorkbook } from "./ingestion/loader.js";
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
    const metadata = index.indexMetadata;
    const reachable = await index.ping();
    const counts = reachable ? await index.stats() : null;
    return {
      ready: Boolean(metadata) && reachable,
      models: resolvedModelNames(config),
      qdrant: {
        url: config.QDRANT_URL,
        collection: config.QDRANT_COLLECTION,
        reachable,
      },
      index: metadata
        ? {
            sourceLabel: metadata.sourceLabel,
            documentCount: metadata.documentCount,
            chunkCount: counts?.chunkCount ?? metadata.chunkCount,
            ingestedAt: metadata.ingestedAt,
          }
        : null,
    };
  }

  async ingest(path: string) {
    // Single-flight ingestion: replacing the index while another ingest runs
    // would interleave embeddings calls and waste quota.
    if (this.ingestInFlight) {
      throw new Error("An ingestion is already in progress. Try again when it finishes.");
    }
    const job = this.doIngest(path).finally(() => {
      this.ingestInFlight = null;
    });
    this.ingestInFlight = job;
    return job;
  }

  private async doIngest(path: string) {
    const started = Date.now();
    const loaded = await loadWorkbook(path);
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

    await this.ensureIndex().replaceAll(
      chunks,
      loaded.sourceLabel,
      loaded.documents.length,
      resolvedModelNames(config).embeddings,
    );
    const durationMs = Date.now() - started;
    log("ingest_done", { source: loaded.sourceLabel, durationMs });
    return {
      sourceLabel: loaded.sourceLabel,
      documentCount: loaded.documents.length,
      chunkCount: chunks.length,
      durationMs,
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
