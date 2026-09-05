import { config } from "./config.js";

/** Result of a single deterministic check, as returned by the engine. */
export interface EngineCheckResult {
  name: string;
  status: string;
  detail?: string | null;
}

export interface EngineCheckResponse {
  status: string;
  checks: EngineCheckResult[];
}

export class EngineUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EngineUnavailableError";
  }
}

// Deterministic checks are fast; if the engine takes longer than this it is
// down or wedged, and the caller should get a 503 rather than a hung request.
const ENGINE_TIMEOUT_MS = 10_000;

async function engineFetch(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${config.ENGINE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new EngineUnavailableError(`Engine unreachable at ${config.ENGINE_URL}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new EngineUnavailableError(`Engine returned HTTP ${response.status}`);
  }
  return response;
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** A pipeline step graph, as sketched by the LLM and validated by the engine. */
export interface PipelineDoc {
  name?: string;
  steps: Array<{
    id: string;
    op: string;
    uses?: string[];
    params: Record<string, unknown>;
  }>;
}

/** The engine's operator catalog; opaque to the server (passed to prompts/UI). */
export type OperatorCatalog = Record<string, unknown>;

export interface PipelineValidateResponse {
  ok: boolean;
  errors: string[];
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
}

/** The atomic operators the engine can execute (fed verbatim into prompts). */
export async function getOperators(): Promise<{ operators: OperatorCatalog }> {
  return (await (await engineFetch("/operators")).json()) as { operators: OperatorCatalog };
}

/** Structural validation of a pipeline against the operator catalog. */
export async function validatePipeline(pipeline: unknown): Promise<PipelineValidateResponse> {
  return (await (
    await engineFetch("/pipeline/validate", postJson({ pipeline }))
  ).json()) as PipelineValidateResponse;
}

/** Execute a pipeline against the engine's mounted data (sampled rows). */
export async function runPipeline(
  pipeline: unknown,
  maxRows?: number,
): Promise<PipelineRunResponse> {
  return (await (
    await engineFetch("/pipeline/run", postJson({ pipeline, max_rows: maxRows }))
  ).json()) as PipelineRunResponse;
}

/**
 * Push a workbook's bytes to the engine so pipelines can verify against it
 * (read_sheet resolves uploaded workbooks before the mounted dataset).
 * `asMapping` also reloads the engine's crosswalk tables from the workbook.
 */
export async function uploadData(
  name: string,
  data: Buffer,
  opts?: { asMapping?: boolean },
): Promise<{ ok: boolean; name: string; bytes: number }> {
  const query = new URLSearchParams({ name });
  if (opts?.asMapping) query.set("as_mapping", "true");
  const response = await engineFetch(`/data/upload?${query}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(data),
  });
  return (await response.json()) as { ok: boolean; name: string; bytes: number };
}

/** Remove all uploaded workbooks from the engine (paired with clearIndex). */
export async function clearUploads(): Promise<void> {
  await engineFetch("/data/uploads", { method: "DELETE" });
}

/** Forward a loader batch / GL rows to the deterministic engine's /check. */
export async function checkBatch(payload: unknown): Promise<EngineCheckResponse> {
  let response: Response;
  try {
    response = await fetch(`${config.ENGINE_URL}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new EngineUnavailableError(`Engine unreachable at ${config.ENGINE_URL}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new EngineUnavailableError(`Engine returned HTTP ${response.status}`);
  }
  return (await response.json()) as EngineCheckResponse;
}

export async function validateMapping(): Promise<{ ok: boolean; entity_result: unknown; coa_result: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${config.ENGINE_URL}/validate_mapping`, {
      method: "GET",
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new EngineUnavailableError(`Engine unreachable at ${config.ENGINE_URL}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new EngineUnavailableError(`Engine returned HTTP ${response.status}`);
  }
  return await response.json() as { ok: boolean; entity_result: unknown; coa_result: unknown };
}