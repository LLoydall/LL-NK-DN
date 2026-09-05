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

export interface IndexInfo {
  sourceLabel: string;
  documentCount: number;
  chunkCount: number;
  ingestedAt: string;
}

export interface StatusResponse {
  ready: boolean;
  models: { chat: string; embeddings: string };
  qdrant: { url: string; collection: string; reachable: boolean };
  index: IndexInfo | null;
  sources: IndexInfo[];
}

export type IngestMode = "append" | "replace";

export interface IngestResponse {
  sourceLabel: string;
  documentCount: number;
  chunkCount: number;
  durationMs: number;
  mode: IngestMode;
}

export interface ReviewCheckResponse {
  engine: unknown;
  latencyMs: number;
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
  ingest: (file: File, mode: IngestMode) => {
    const form = new FormData();
    form.append("file", file);
    form.append("mode", mode);
    return request<IngestResponse>("/api/ingest", { method: "POST", body: form });
  },
  chat: (question: string, history: ChatHistoryMessage[]) =>
    request<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify({ question, history }) }),
  reviewCheck: (payload: unknown) =>
    request<ReviewCheckResponse>("/api/review/check", { method: "POST", body: JSON.stringify({ payload }) }),
  clearIndex: () => request<{ cleared: boolean }>("/api/index", { method: "DELETE" }),
};
