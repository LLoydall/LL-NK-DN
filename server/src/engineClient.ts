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
