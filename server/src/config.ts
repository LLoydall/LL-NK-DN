import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvFiles } from "dotenv";
import { z } from "zod";

// Repo-root .env is shared with the engine and docker builds; server/.env may
// override individual values. dotenv never overrides real environment
// variables, and earlier paths win. Paths resolve from this module so the cwd
// (server/ in dev, /app in the container) doesn't matter.
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
loadEnvFiles({
  path: [path.resolve(SERVER_DIR, "../../.env"), path.resolve(SERVER_DIR, "../.env")],
});

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  // GCP / Vertex AI. Chat runs on a Model Garden open model via its
  // OpenAI-compatible endpoint; embeddings use a first-party Vertex model.
  GCP_PROJECT_ID: z.string().default("priv-mkt-hack26lon-3752"),
  VERTEX_LOCATION: z.string().default("europe-west2"),
  // First-party Gemini publisher model (no deployment needed). To use a
  // deployed Model Garden model (e.g. Qwen) instead, set VERTEX_CHAT_MODEL to
  // its served model id AND set VERTEX_CHAT_ENDPOINT_ID below.
  VERTEX_CHAT_MODEL: z.string().default("gemini-2.5-flash"),
  // Dedicated Model Garden endpoint id; when set, chat goes through that
  // endpoint's OpenAI-compatible route instead of first-party Gemini.
  VERTEX_CHAT_ENDPOINT_ID: z.string().optional(),
  VERTEX_EMBEDDING_MODEL: z.string().default("text-embedding-004"),
  // Only place ADC env vars are read; google-auth-library resolves the rest.
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  // Vector store.
  QDRANT_URL: z.string().url().default("http://localhost:6333"),
  QDRANT_COLLECTION: z.string().default("ylookup-rules"),
  // Deterministic engine sidecar (see engine/ in the repo root).
  ENGINE_URL: z.string().url().default("http://localhost:8081"),
  // Retrieval tuning.
  TOP_K: z.coerce.number().int().min(1).max(50).default(12),
  // Minimum cosine similarity (Qdrant scores, higher = better).
  SCORE_THRESHOLD: z.coerce.number().min(-1).max(1).default(0.25),
  // Context management: hard cap on characters of retrieved context per answer.
  MAX_CONTEXT_CHARS: z.coerce.number().int().positive().default(12_000),
  // Chat history window (messages, not turns) sent to the model.
  MAX_HISTORY_MESSAGES: z.coerce.number().int().min(0).default(6),
  CHUNK_SIZE: z.coerce.number().int().positive().default(1_000),
  CHUNK_OVERLAP: z.coerce.number().int().min(0).default(150),
  // Request body limit for chat questions.
  MAX_QUESTION_CHARS: z.coerce.number().int().positive().default(4_000),
  // Ingestion limit; the reference workbook is ~2MB, leave headroom.
  MAX_FILE_BYTES: z.coerce.number().int().positive().default(20_000_000),
  // Embedding pacing: lab projects have tiny per-minute request quotas on the
  // embeddings model. Max 250 instances per Vertex request.
  EMBED_BATCH_SIZE: z.coerce.number().int().min(1).max(250).default(250),
  // Pause between embedding batches to stay under requests-per-minute quota.
  EMBED_BATCH_DELAY_MS: z.coerce.number().int().min(0).default(2_500),
  // Retries per batch on 429/RESOURCE_EXHAUSTED with exponential backoff.
  EMBED_MAX_RETRIES: z.coerce.number().int().min(0).default(5),
});

const env = envSchema.parse(process.env);

/** Absolute path of the monorepo root (parent of server/). */
export const REPO_ROOT = path.resolve(SERVER_DIR, "../..");

export const config = { ...env } as const;

export type AppConfig = typeof config;
