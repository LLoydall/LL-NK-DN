import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./observability.js";
import {
  checkBatch,
  clearUploads,
  getOperators,
  runPipeline as engineRunPipeline,
  uploadData,
  validateMapping,
  validatePipeline,
  type EngineCheckResponse,
  type PipelineRunResponse,
} from "./engineClient.js";
import { chunkSheetDocuments } from "./ingestion/chunker.js";
import { loadUploadedWorkbook, loadWorkbook } from "./ingestion/loader.js";
import type { CorpusCategory } from "./ingestion/xlsx.js";
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
import {
  buildPipelineGraph,
  runPipelineSketch,
  type PipelineGraph,
  type PipelineSketchResult,
} from "./rag/pipeline.js";

/**
 * Application service: owns the singleton vector index, chat graph, ingestion
 * pipeline, and the engine client. A class (not module state) so tests can
 * instantiate it with fakes.
 */
export class MigrationService {
  private index: RuleIndex | null = null;
  private graph: ChatGraph | null = null;
  private pipelineGraph: PipelineGraph | null = null;
  private model: BaseChatModel | null = null;
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

  private async ensureModel(): Promise<BaseChatModel> {
    // Throws MissingCredentialError when ADC is not available.
    if (!this.model) {
      this.model = await createChatModel(config);
    }
    return this.model;
  }

  private async ensureGraph(): Promise<ChatGraph> {
    if (!this.graph) {
      this.graph = buildChatGraph({ index: this.ensureIndex(), model: await this.ensureModel() });
    }
    return this.graph;
  }

  private async ensurePipelineGraph(): Promise<PipelineGraph> {
    if (!this.pipelineGraph) {
      this.pipelineGraph = buildPipelineGraph({
        index: this.ensureIndex(),
        model: await this.ensureModel(),
        engine: { getOperators, validatePipeline },
      });
    }
    return this.pipelineGraph;
  }

  async status() {
    const index = this.ensureIndex();
    const sources = index.sourcesMetadata;
    const reachable = await index.ping();
    const counts = reachable ? await index.stats() : null;
    const latest = sources[sources.length - 1];
    const documentCount = sources.reduce((sum, m) => sum + m.documentCount, 0);
    const byCategory: Record<CorpusCategory, { sources: number; chunks: number }> = {
      input: { sources: 0, chunks: 0 },
      mapping: { sources: 0, chunks: 0 },
      output: { sources: 0, chunks: 0 },
    };
    for (const s of sources) {
      byCategory[s.category].sources += 1;
      byCategory[s.category].chunks += s.chunkCount;
    }
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
            byCategory,
          }
        : null,
      sources: sources.map(({ sourceLabel, category, documentCount, chunkCount, ingestedAt }) => ({
        sourceLabel,
        category,
        documentCount,
        chunkCount,
        ingestedAt,
      })),
    };
  }

  async ingest(input: IngestInput, mode: IngestMode = "append", category: CorpusCategory = "mapping") {
    // Single-flight ingestion: mutating the index while another ingest runs
    // would interleave embeddings calls and waste quota.
    if (this.ingestInFlight) {
      throw new Error("An ingestion is already in progress. Try again when it finishes.");
    }
    const job = this.doIngest(input, mode, category).finally(() => {
      this.ingestInFlight = null;
    });
    this.ingestInFlight = job;
    return job;
  }

  private async doIngest(input: IngestInput, mode: IngestMode, category: CorpusCategory) {
    const started = Date.now();
    const loaded =
      "path" in input
        ? await loadWorkbook(input.path, category)
        : loadUploadedWorkbook(input.buffer, input.originalname, category);
    log("ingest_loaded", {
      source: loaded.sourceLabel,
      category,
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
      await index.replaceAll(
        chunks,
        loaded.sourceLabel,
        loaded.documents.length,
        embeddingModel,
        category,
      );
    } else {
      await index.addAll(
        chunks,
        loaded.sourceLabel,
        loaded.documents.length,
        embeddingModel,
        category,
      );
    }
    // Push the workbook to the engine so pipelines can verify against it.
    // Best-effort: retrieval still works if the engine is down, so report
    // rather than fail. A mapping workbook with the reference sheets also
    // reloads the engine's crosswalk tables.
    const sheets = new Set(loaded.documents.map((d) => d.metadata.sheet));
    const asMapping =
      category === "mapping" && MAPPING_REFERENCE_SHEETS.every((s) => sheets.has(s));
    let engineSync = false;
    try {
      await uploadData(path.basename(loaded.sourceLabel), loaded.raw, { asMapping });
      engineSync = true;
    } catch (error) {
      log("engine_upload_failed", { source: loaded.sourceLabel, error: String(error) });
    }
    const durationMs = Date.now() - started;
    log("ingest_done", { source: loaded.sourceLabel, mode, category, engineSync, durationMs });
    return {
      sourceLabel: loaded.sourceLabel,
      category,
      documentCount: loaded.documents.length,
      chunkCount: chunks.length,
      durationMs,
      mode,
      engineSync,
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

  async sketchPipeline(question: string): Promise<PipelineSketchResult> {
    if (!this.index?.isReady) {
      throw new IndexNotReadyError();
    }
    return runPipelineSketch(await this.ensurePipelineGraph(), question);
  }

  async runPipeline(pipeline: unknown, maxRows?: number): Promise<PipelineRunResponse> {
    return engineRunPipeline(pipeline, maxRows);
  }
  
  async validateMapping(): Promise<{ ok: boolean; entity_result: unknown; coa_result: unknown }> {
    return validateMapping();
  }

  async reviewCheck(payload: unknown): Promise<{ engine: EngineCheckResponse; latencyMs: number }> {
    const started = Date.now();
    const engine = await checkBatch(payload);
    return { engine, latencyMs: Date.now() - started };
  }

  async clearIndex(): Promise<void> {
    if (this.index) await this.index.clear();
    try {
      await clearUploads();
    } catch (error) {
      log("engine_clear_uploads_failed", { error: String(error) });
    }
  }
}

export class IndexNotReadyError extends Error {
  constructor() {
    super("No workbook has been ingested yet. Ingest a workbook first.");
    this.name = "IndexNotReadyError";
  }
}

// Sheet set the engine needs to (re)build its crosswalk tables — an ingested
// mapping workbook only reloads engine tables when it has all of these.
const MAPPING_REFERENCE_SHEETS = [
  "LE Mapping",
  "Investor Mapping",
  "Deal Mapping",
  "CoA Mapping",
  "Batch Preference",
];

export type IngestMode = "append" | "replace";

/** Path flow (dev) or an uploaded workbook buffer (multipart). */
export type IngestInput = { path: string } | { buffer: Buffer; originalname: string };
