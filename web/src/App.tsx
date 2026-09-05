import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { api, type ChatHistoryMessage, type IngestMode, type SourceRef, type StatusResponse } from "./api";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: SourceRef[];
  meta?: { latencyMs: number; model: string };
}

const SUGGESTED_QUESTIONS = [
  "What are the steps in the migration process?",
  "How does the batch type override rule work?",
  "Which accounts have no mapping to the target CoA?",
  "How are investors mapped to the target system?",
];

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [tab, setTab] = useState<"ask" | "review">("ask");

  const refreshStatus = useCallback(() => {
    api.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(refreshStatus, [refreshStatus]);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">Y</span>
          <div>
            <h1>YLookup</h1>
            <p>GL → loader migration assistant</p>
          </div>
        </div>
        <IngestPanel onIngested={refreshStatus} />
        {status && (
          <div className="status-card">
            <h2>Models</h2>
            <dl>
              <dt>Chat</dt>
              <dd className="mono break">{status.models.chat}</dd>
              <dt>Embeddings</dt>
              <dd className="mono break">{status.models.embeddings}</dd>
            </dl>
          </div>
        )}
        {status && (
          <div className="status-card">
            <h2>Qdrant</h2>
            <dl>
              <dt>URL</dt>
              <dd className="mono break">{status.qdrant.url}</dd>
              <dt>Collection</dt>
              <dd className="mono break">{status.qdrant.collection}</dd>
              <dt>Reachable</dt>
              <dd>
                <span className={`badge ${status.qdrant.reachable ? "ok" : "bad"}`}>
                  {status.qdrant.reachable ? "yes" : "no"}
                </span>
              </dd>
            </dl>
          </div>
        )}
        {status?.index && (
          <div className="status-card">
            <h2>Corpus</h2>
            <dl>
              <dt>Documents</dt>
              <dd>{status.index.documentCount.toLocaleString()}</dd>
              <dt>Chunks</dt>
              <dd>{status.index.chunkCount.toLocaleString()}</dd>
              <dt>Sources</dt>
              <dd>{status.sources.length}</dd>
            </dl>
            <ul className="source-list">
              {status.sources.map((s, i) => (
                <li key={`${s.sourceLabel}-${i}`}>
                  <span className="mono break">{s.sourceLabel}</span>
                  <span className="source-meta">
                    {s.chunkCount.toLocaleString()} chunks · {new Date(s.ingestedAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
            <button className="ghost danger" onClick={() => api.clearIndex().then(refreshStatus)}>
              Clear index
            </button>
          </div>
        )}
      </aside>

      <main className="main">
        <div className="main-tabs">
          <button className={tab === "ask" ? "active" : ""} onClick={() => setTab("ask")}>
            Ask
          </button>
          <button className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}>
            Review queue
          </button>
        </div>
        {tab === "ask" ? <AskTab status={status} /> : <ReviewTab />}
      </main>
    </div>
  );
}

function IngestPanel({ onIngested }: { onIngested: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<IngestMode>("append");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || loading) return;
    setLoading(true);
    setError(null);
    setLastResult(null);
    try {
      const res = await api.ingest(file, mode);
      const docs = res.documentCount.toLocaleString();
      const chunks = res.chunkCount.toLocaleString();
      const secs = (res.durationMs / 1000).toFixed(1);
      setLastResult(
        res.mode === "replace"
          ? `Replaced corpus with ${docs} documents (${chunks} chunks) in ${secs}s`
          : `Added ${docs} documents (${chunks} chunks) to the corpus in ${secs}s`,
      );
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      onIngested();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ingestion failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ingest-card">
      <h2>Workbook</h2>
      <form onSubmit={submit}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={loading}
        />
        <div className="mode-toggle">
          <button
            type="button"
            className={mode === "append" ? "active" : ""}
            onClick={() => setMode("append")}
            disabled={loading}
          >
            Add to corpus
          </button>
          <button
            type="button"
            className={mode === "replace" ? "active" : ""}
            onClick={() => setMode("replace")}
            disabled={loading}
          >
            Replace corpus
          </button>
        </div>
        <button type="submit" disabled={loading || !file}>
          {loading ? "Ingesting…" : "Ingest"}
        </button>
      </form>
      <p className="hint">Upload a .xlsx workbook — added to the corpus, or replacing it entirely.</p>
      {loading && <p className="hint">Parsing, chunking and embedding — large workbooks take a minute.</p>}
      {error && <p className="error-text">{error}</p>}
      {lastResult && <p className="success-text">{lastResult}</p>}
    </div>
  );
}

function AskTab({ status }: { status: StatusResponse | null }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setChatError(null);
    setInput("");
    setBusy(true);
    setMessages((prev) => [...prev, { role: "user", content: q }]);
    try {
      const history: ChatHistoryMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
      const res = await api.chat(q, history);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: res.answer,
          sources: res.sources,
          meta: { latencyMs: res.latencyMs, model: res.model },
        },
      ]);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Something went wrong");
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <h2>Ask anything about the migration</h2>
            <p>
              Ingest the mapping-rules workbook, then ask about crosswalks, override
              rules, chart-of-accounts mappings, and migration steps.
            </p>
            <div className="suggestions">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button key={q} onClick={() => ask(q)} disabled={!status?.ready || busy}>
                  {q}
                </button>
              ))}
            </div>
            {!status?.ready && <p className="hint">Ingest a workbook first to enable the assistant.</p>}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            <div className="bubble">
              {m.role === "assistant" ? <ReactMarkdown>{m.content}</ReactMarkdown> : m.content}
            </div>
            {m.sources && m.sources.length > 0 && (
              <div className="sources">
                {m.sources.map((s) => (
                  <span key={s.sheet} className="source-chip" title={`relevance ${s.score}`}>
                    {s.sheet}
                  </span>
                ))}
              </div>
            )}
            {m.meta && (
              <div className="meta">
                {m.meta.latencyMs} ms · {m.meta.model}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="message assistant">
            <div className="bubble typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
        {chatError && <div className="error-banner">{chatError}</div>}
        <div ref={bottomRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={status?.ready ? "Ask about the migration…" : "Ingest a workbook to start…"}
          disabled={!status?.ready || busy}
          autoFocus
        />
        <button type="submit" disabled={!status?.ready || busy || !input.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}

interface ReviewRow {
  id: string;
  entity: string;
  account: string;
  transType: string;
  issue: string;
}

const REVIEW_ROWS: ReviewRow[] = [
  { id: "RV-001", entity: "Tranche 1 Fund LP", account: "41200 — Mgmt fee income", transType: "MFEE", issue: "No CoA mapping for trans type MFEE" },
  { id: "RV-002", entity: "Tranche 1 Fund LP", account: "52010 — Admin expenses", transType: "ADMF", issue: "Ambiguous mapping: 2 candidate target accounts" },
  { id: "RV-003", entity: "Investor J. Smith", account: "30100 — Capital calls", transType: "CCALL", issue: "Investor ID not found in target register" },
  { id: "RV-004", entity: "Tranche 1 Fund LP", account: "61005 — FX revaluation", transType: "FXRV", issue: "No CoA mapping for trans type FXRV" },
];

type ReviewState =
  | { kind: "pending" }
  | { kind: "checking" }
  | { kind: "approved"; engine: string; latencyMs: number }
  | { kind: "approve-error"; message: string }
  | { kind: "rejected" };

function ReviewTab() {
  const [states, setStates] = useState<Record<string, ReviewState>>({});

  const stateFor = (id: string): ReviewState => states[id] ?? { kind: "pending" };

  async function approve(row: ReviewRow) {
    setStates((prev) => ({ ...prev, [row.id]: { kind: "checking" } }));
    try {
      const res = await api.reviewCheck({ action: "approve", row });
      setStates((prev) => ({
        ...prev,
        [row.id]: { kind: "approved", engine: JSON.stringify(res.engine, null, 2), latencyMs: res.latencyMs },
      }));
    } catch (err) {
      setStates((prev) => ({
        ...prev,
        [row.id]: { kind: "approve-error", message: err instanceof Error ? err.message : "Engine check failed" },
      }));
    }
  }

  function reject(row: ReviewRow) {
    setStates((prev) => ({ ...prev, [row.id]: { kind: "rejected" } }));
  }

  return (
    <div className="review">
      <div className="notice-banner">
        The deterministic checking engine is not implemented yet — approve responses
        will come back as stubs (or a 503 while the engine is unavailable).
      </div>
      <table className="review-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Entity</th>
            <th>Account</th>
            <th>Trans type</th>
            <th>Issue</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {REVIEW_ROWS.map((row) => {
            const st = stateFor(row.id);
            const decided = st.kind !== "pending" && st.kind !== "checking" && st.kind !== "approve-error";
            return (
              <FragmentRow
                key={row.id}
                row={row}
                state={st}
                decided={decided}
                onApprove={() => approve(row)}
                onReject={() => reject(row)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({
  row,
  state,
  decided,
  onApprove,
  onReject,
}: {
  row: ReviewRow;
  state: ReviewState;
  decided: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <>
      <tr>
        <td className="mono">{row.id}</td>
        <td>{row.entity}</td>
        <td>{row.account}</td>
        <td className="mono">{row.transType}</td>
        <td>{row.issue}</td>
        <td className="decision-cell">
          {state.kind === "pending" && (
            <>
              <button className="small approve" onClick={onApprove}>
                Approve
              </button>
              <button className="small ghost danger" onClick={onReject}>
                Reject
              </button>
            </>
          )}
          {state.kind === "checking" && <span className="hint">Checking…</span>}
          {state.kind === "approved" && <span className="badge ok">approved</span>}
          {state.kind === "approve-error" && (
            <>
              <button className="small approve" onClick={onApprove}>
                Retry
              </button>
              <button className="small ghost danger" onClick={onReject} disabled={decided}>
                Reject
              </button>
            </>
          )}
          {state.kind === "rejected" && <span className="badge bad">rejected</span>}
        </td>
      </tr>
      {state.kind === "approved" && (
        <tr className="detail-row">
          <td colSpan={6}>
            <p className="hint">Engine response · {state.latencyMs} ms</p>
            <pre className="engine-json">{state.engine}</pre>
          </td>
        </tr>
      )}
      {state.kind === "approve-error" && (
        <tr className="detail-row">
          <td colSpan={6}>
            <p className="error-text">{state.message}</p>
          </td>
        </tr>
      )}
    </>
  );
}
