export type CorpusCategory = "input" | "mapping" | "output";

export interface SourceRef {
  sheet: string;
  category: string;
  score: number;
}

export interface ChatResponse {
  answer: string;
  sources: SourceRef[];
  latencyMs: number;
  model: string;
}

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface IndexInfo {
  sourceLabel: string;
  category: CorpusCategory;
  documentCount: number;
  chunkCount: number;
  ingestedAt: string;
}

export interface StatusResponse {
  ready: boolean;
  models: { chat: string; embeddings: string };
  qdrant: { url: string; collection: string; reachable: boolean };
  index: (IndexInfo & { byCategory: Record<CorpusCategory, { sources: number; chunks: number }> }) | null;
  sources: IndexInfo[];
}

export type IngestMode = "append" | "replace";

export interface IngestResponse {
  sourceLabel: string;
  category: CorpusCategory;
  documentCount: number;
  chunkCount: number;
  durationMs: number;
  mode: IngestMode;
  /** Whether the workbook bytes also reached the engine (pipeline verification). */
  engineSync: boolean;
}

export interface ReviewCheckResponse {
  engine: unknown;
  latencyMs: number;
}

/** A pipeline DAG sketched by the LLM out of the engine's atomic operators. */
export interface PipelineDoc {
  name?: string;
  steps: Array<{
    id: string;
    op: string;
    uses?: string[];
    params: Record<string, unknown>;
  }>;
}

export interface PipelineSketchResponse {
  pipeline: PipelineDoc | null;
  explanation: string;
  validation: { ok: boolean; errors: string[] };
  sources: SourceRef[];
  latencyMs: number;
  model: string;
}

export interface PipelineStepResult {
  id: string;
  op: string;
  kind: string;
  status: string;
  rowCount?: number;
  sample?: Array<Record<string, unknown>>;
  checks?: Record<string, unknown>;
  unmatched?: number;
  error?: string;
}

export interface PipelineRunResponse {
  ok: boolean;
  steps?: PipelineStepResult[];
  errors?: string[];
  output?: {
    step: string;
    complete: boolean;
    rowCount: number;
    columns: string[];
    rows: Array<Record<string, unknown>>;
  } | null;
}

/** Result of diffing the pipeline's output against the trusted reference mapping. */
export interface KnownMappingValidation {
  ok: boolean;
  status?: string;
  errors?: string[];
  reason?: string;
  rows_checked?: number;
  columns_checked?: string[];
  mismatch_count?: number;
  mismatches?: Array<{ row: number; column: string; actual: unknown; expected: unknown }>;
  pipeline_rows?: number;
  expected_rows?: number;
  missing_columns?: string[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData bodies must not get a JSON content-type — the browser sets the
  // multipart boundary itself.
  const isForm = init?.body instanceof FormData;
  const res = await fetch(path, {
    ...init,
    headers: isForm ? init?.headers : { "Content-Type": "application/json", ...init?.headers },
  });
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const body = isJson ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed: HTTP ${res.status}`);
  }
  if (!isJson) {
    // A static host answering API paths with index.html would otherwise
    // surface as an inscrutable crash downstream.
    throw new Error("The API returned a non-JSON response — is the backend running?");
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean }>("/api/health"),
  status: () => request<StatusResponse>("/api/status"),
  ingest: (file: File, mode: IngestMode, category: CorpusCategory) => {
    const form = new FormData();
    form.append("file", file);
    form.append("mode", mode);
    form.append("category", category);
    return request<IngestResponse>("/api/ingest", { method: "POST", body: form });
  },
  chat: (question: string, history: ChatHistoryMessage[]) =>
    request<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify({ question, history }) }),
  sketchPipeline: (question: string) =>
    request<PipelineSketchResponse>("/api/pipeline/sketch", {
      method: "POST",
      body: JSON.stringify({ question }),
    }),
  runPipeline: (pipeline: PipelineDoc, maxRows?: number) =>
    request<PipelineRunResponse>("/api/pipeline/run", {
      method: "POST",
      body: JSON.stringify({ pipeline, maxRows }),
    }),
  validateAgainstKnownMapping: (pipeline: PipelineDoc, knownMappingFunction: string, maxRows?: number) =>
    request<KnownMappingValidation>("/api/pipeline/validate-against-known-mapping", {
      method: "POST",
      body: JSON.stringify({ pipeline, knownMappingFunction, maxRows }),
    }),
  reviewCheck: (payload: unknown) =>
    request<ReviewCheckResponse>("/api/review/check", { method: "POST", body: JSON.stringify({ payload }) }),
  validateMapping: () => request<{ ok: boolean; entity_result: unknown; coa_result: unknown }>("/api/validate_mapping"),
  clearIndex: () => request<{ cleared: boolean }>("/api/index", { method: "DELETE" }),
};
