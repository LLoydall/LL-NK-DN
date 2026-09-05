export interface SourceRef {
  sheet: string;
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

export interface StatusResponse {
  ready: boolean;
  models: { chat: string; embeddings: string };
  qdrant: { url: string; collection: string; reachable: boolean };
  index: {
    sourceLabel: string;
    documentCount: number;
    chunkCount: number;
    ingestedAt: string;
  } | null;
}

export interface IngestResponse {
  sourceLabel: string;
  documentCount: number;
  chunkCount: number;
  durationMs: number;
}

export interface ReviewCheckResponse {
  engine: unknown;
  latencyMs: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
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
  ingest: (path: string) =>
    request<IngestResponse>("/api/ingest", { method: "POST", body: JSON.stringify({ path }) }),
  chat: (question: string, history: ChatHistoryMessage[]) =>
    request<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify({ question, history }) }),
  reviewCheck: (payload: unknown) =>
    request<ReviewCheckResponse>("/api/review/check", { method: "POST", body: JSON.stringify({ payload }) }),
  clearIndex: () => request<{ cleared: boolean }>("/api/index", { method: "DELETE" }),
};
