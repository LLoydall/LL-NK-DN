import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { api, type ChatHistoryMessage, type CorpusCategory, type IngestMode, type PipelineRunResponse, type PipelineSketchResponse, type PipelineStepResult, type SourceRef, type StatusResponse } from "./api";

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

const CATEGORY_LABELS: Record<CorpusCategory, string> = {
  input: "Source input",
  mapping: "Mapping rules",
  output: "Target output",
};

/** Chips are keyed category:sheet — collapse duplicate chunks of one sheet. */
function uniqueSources(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const key = `${s.category}:${s.sheet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [tab, setTab] = useState<"ask" | "pipeline" | "review">("ask");

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
              <dt>By category</dt>
              <dd>
                {(Object.keys(CATEGORY_LABELS) as CorpusCategory[])
                  .filter((c) => status.index?.byCategory[c].sources)
                  .map((c) => `${CATEGORY_LABELS[c]}: ${status.index?.byCategory[c].chunks.toLocaleString()} chunks`)
                  .join(" · ") || "—"}
              </dd>
            </dl>
            <ul className="source-list">
              {status.sources.map((s, i) => (
                <li key={`${s.sourceLabel}-${i}`}>
                  <span className="mono break">{s.sourceLabel}</span>
                  <span className="source-meta">
                    <span className={`category-badge ${s.category}`}>{CATEGORY_LABELS[s.category]}</span>{" "}
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
          <button className={tab === "pipeline" ? "active" : ""} onClick={() => setTab("pipeline")}>
            Pipeline
          </button>
          <button className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}>
            Review queue
          </button>
        </div>
        {tab === "ask" ? <AskTab status={status} /> : tab === "pipeline" ? <PipelineTab status={status} /> : <ReviewTab />}
      </main>
    </div>
  );
}

function IngestPanel({ onIngested }: { onIngested: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<IngestMode>("append");
  const [category, setCategory] = useState<CorpusCategory>("mapping");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [engineWarning, setEngineWarning] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || loading) return;
    setLoading(true);
    setError(null);
    setLastResult(null);
    setEngineWarning(null);
    try {
      const res = await api.ingest(file, mode, category);
      const docs = res.documentCount.toLocaleString();
      const chunks = res.chunkCount.toLocaleString();
      const secs = (res.durationMs / 1000).toFixed(1);
      setLastResult(
        res.mode === "replace"
          ? `Replaced corpus with ${docs} documents (${chunks} chunks) in ${secs}s`
          : `Added ${docs} ${CATEGORY_LABELS[res.category].toLowerCase()} documents (${chunks} chunks) to the corpus in ${secs}s`,
      );
      if (!res.engineSync) {
        setEngineWarning(
          "The workbook did not reach the engine — pipeline runs can't verify against it. Is the engine running?",
        );
      }
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
        <div className="mode-toggle" title="What is this workbook? Input = source-system data, mapping = the translation rules, output = target-format artifacts.">
          {(Object.keys(CATEGORY_LABELS) as CorpusCategory[]).map((c) => (
            <button
              key={c}
              type="button"
              className={category === c ? "active" : ""}
              onClick={() => setCategory(c)}
              disabled={loading}
            >
              {CATEGORY_LABELS[c]}
            </button>
          ))}
        </div>
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
      {engineWarning && <p className="error-text">{engineWarning}</p>}
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
                {uniqueSources(m.sources).map((s) => (
                  <span key={`${s.category}-${s.sheet}`} className="source-chip" title={`${s.category} · relevance ${s.score}`}>
                    {s.category}:{s.sheet}
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

/* ---------- Pipeline tab: LLM-sketched operator DAG, run by the engine ---------- */

type StepKind = "source" | "transform" | "terminal";

function stepKind(op: string): StepKind {
  if (op === "read_sheet") return "source";
  if (op.startsWith("assert_")) return "terminal";
  return "transform";
}

type StepNodeData = {
  op: string;
  kind: StepKind;
  uses: string[];
  paramsText: string;
  paramsError?: string;
  result?: PipelineStepResult;
  onParamsChange: (stepId: string, text: string) => void;
};
type StepFlowNode = Node<StepNodeData, "step">;

function formatCell(value: unknown): string {
  if (value == null) return "∅";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function CheckView({ checks }: { checks: Record<string, unknown> }) {
  const status = String(checks.status ?? "");
  const entries = Object.entries(checks).filter(
    ([k, v]) => k !== "status" && ["string", "number", "boolean"].includes(typeof v),
  );
  return (
    <div className="check-view">
      {status && (
        <span className={`badge ${status === "PASS" ? "ok" : status === "FAIL" ? "bad" : "warn"}`}>
          {status}
        </span>
      )}
      {entries.map(([k, v]) => (
        <span key={k} className="meta">
          {k}: {formatCell(v)}
        </span>
      ))}
    </div>
  );
}

function SampleTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  const columns = Object.keys(rows[0]).slice(0, 6);
  const truncated = Object.keys(rows[0]).length > columns.length;
  return (
    <div className="sample-scroll nodrag">
      <table className="sample-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
            {truncated && <th>…</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>{formatCell(r[c])}</td>
              ))}
              {truncated && <td>…</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StepNode({ id, data }: NodeProps<StepFlowNode>) {
  const result = data.result;
  return (
    <div className={`step-node ${data.kind}`}>
      {data.kind !== "source" && <Handle type="target" position={Position.Left} />}
      <div className="step-head">
        <span className={`op-badge ${data.kind}`}>{data.op}</span>
        <span className="step-id mono">{id}</span>
        {result && (
          <span className={`badge ${result.status === "ok" ? "ok" : result.status === "error" ? "bad" : "warn"}`}>
            {result.status}
          </span>
        )}
      </div>
      {data.uses.length > 0 && <div className="step-uses meta">input: {data.uses.join(", ")}</div>}
      <textarea
        className="params-editor nodrag mono"
        spellCheck={false}
        value={data.paramsText}
        rows={Math.min(9, Math.max(2, data.paramsText.split("\n").length))}
        onChange={(e) => data.onParamsChange(id, e.target.value)}
      />
      {data.paramsError && <p className="error-text">{data.paramsError}</p>}
      {result && (
        <div className="step-result">
          {result.error && <p className="error-text">{result.error}</p>}
          {(result.rowCount != null || result.unmatched != null) && (
            <div className="meta">
              {result.rowCount != null && `${result.rowCount.toLocaleString()} rows`}
              {result.rowCount != null && result.unmatched != null && " · "}
              {result.unmatched != null && `${result.unmatched} unmatched`}
            </div>
          )}
          {result.checks && <CheckView checks={result.checks} />}
          {result.sample && result.sample.length > 0 && <SampleTable rows={result.sample} />}
        </div>
      )}
      {data.kind !== "terminal" && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

const nodeTypes = { step: StepNode };

function PipelineTab({ status }: { status: StatusResponse | null }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sketch, setSketch] = useState<PipelineSketchResponse | null>(null);
  const [paramsDraft, setParamsDraft] = useState<Record<string, string>>({});
  const [paramsErrors, setParamsErrors] = useState<Record<string, string>>({});
  const [runResults, setRunResults] = useState<Record<string, PipelineStepResult>>({});
  const [running, setRunning] = useState(false);
  const [maxRows, setMaxRows] = useState(200);
  const [nodes, setNodes, onNodesChange] = useNodesState<StepFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [flow, setFlow] = useState<ReactFlowInstance<StepFlowNode, Edge> | null>(null);

  const onParamsChange = useCallback((stepId: string, text: string) => {
    setParamsDraft((prev) => ({ ...prev, [stepId]: text }));
  }, []);

  // Rebuild the graph for each new sketch. Layered layout: depth = longest
  // chain of `uses` refs back to a source; nodes in a layer stack vertically.
  useEffect(() => {
    if (!sketch?.pipeline) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const steps = sketch.pipeline.steps;
    const refsOf = (i: number): string[] => steps[i].uses ?? (i > 0 ? [steps[i - 1].id] : []);
    const depth = new Map<string, number>();
    const perLayer = new Map<number, number>();
    const newNodes: StepFlowNode[] = [];
    const newEdges: Edge[] = [];
    steps.forEach((step, i) => {
      const refs = refsOf(i).filter((r) => steps.some((s) => s.id === r));
      const d = refs.length > 0 ? Math.max(...refs.map((r) => (depth.get(r) ?? 0) + 1)) : 0;
      depth.set(step.id, d);
      const slot = perLayer.get(d) ?? 0;
      perLayer.set(d, slot + 1);
      newNodes.push({
        id: step.id,
        type: "step",
        position: { x: d * 380, y: slot * 280 },
        data: {
          op: step.op,
          kind: stepKind(step.op),
          uses: refs,
          paramsText: JSON.stringify(step.params ?? {}, null, 2),
          onParamsChange,
        },
      });
      for (const ref of refs) {
        newEdges.push({ id: `${ref}->${step.id}`, source: ref, target: step.id, animated: true });
      }
    });
    setParamsDraft(Object.fromEntries(newNodes.map((n) => [n.id, n.data.paramsText])));
    setParamsErrors({});
    setRunResults({});
    setNodes(newNodes);
    setEdges(newEdges);
    // The canvas initializes (and its fitView runs) with zero nodes; the
    // sketch arrives seconds later, so re-fit once the graph exists or the
    // nodes land outside the visible viewport.
    const refit = setTimeout(() => flow?.fitView({ padding: 0.2 }), 50);
    return () => clearTimeout(refit);
  }, [sketch, onParamsChange, setNodes, setEdges, flow]);

  // Push param edits / run results into existing nodes (positions preserved).
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        data: {
          ...n.data,
          paramsText: paramsDraft[n.id] ?? n.data.paramsText,
          paramsError: paramsErrors[n.id],
          result: runResults[n.id],
        },
      })),
    );
  }, [paramsDraft, paramsErrors, runResults, setNodes]);

  async function sketchIt(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSketch(await api.sketchPipeline(text));
    } catch (err) {
      setSketch(null);
      setError(err instanceof Error ? err.message : "Sketch failed");
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!sketch?.pipeline || running) return;
    // Params are editable JSON; refuse to run with malformed steps.
    const errors: Record<string, string> = {};
    const steps = sketch.pipeline.steps.map((s) => {
      try {
        return { ...s, params: JSON.parse(paramsDraft[s.id] ?? "{}") as Record<string, unknown> };
      } catch {
        errors[s.id] = "params are not valid JSON";
        return s;
      }
    });
    setParamsErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setRunning(true);
    setError(null);
    try {
      const res: PipelineRunResponse = await api.runPipeline({ ...sketch.pipeline, steps }, maxRows);
      if (res.steps) {
        setRunResults(Object.fromEntries(res.steps.map((r) => [r.id, r])));
      }
      if (!res.ok && res.errors) setError(res.errors.join("\n"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="pipeline">
      <div className="pipeline-bar">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sketchIt(question)}
          placeholder="How did the source GL become the loader?"
          disabled={!status?.ready || busy}
        />
        <button onClick={() => sketchIt(question)} disabled={!status?.ready || busy || !question.trim()}>
          {busy ? "Sketching…" : "Sketch pipeline"}
        </button>
        {sketch?.pipeline && (
          <>
            <input
              type="number"
              className="maxrows-input"
              min={1}
              max={10000}
              value={maxRows}
              onChange={(e) => setMaxRows(Math.max(1, Math.min(10_000, Number(e.target.value) || 200)))}
              title="Rows read per source sheet (row cap)"
              disabled={running}
            />
            <button onClick={run} disabled={running}>
              {running ? "Running…" : "Run on sample data"}
            </button>
          </>
        )}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {sketch && !sketch.validation.ok && sketch.validation.errors.length > 0 && (
        <div className="notice-banner">
          Engine validation flagged this draft: {sketch.validation.errors.join("; ")} — edit the
          step params to fix it, or re-sketch.
        </div>
      )}
      <div className="pipeline-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={setFlow}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
        >
          <Background />
          <Controls />
        </ReactFlow>
        {nodes.length === 0 && !busy && (
          <div className="pipeline-empty">
            <h2>Sketch the input → output translation</h2>
            <p>
              The assistant drafts a pipeline from the deterministic engine's atomic operators,
              grounded in the ingested input, mapping rules, and output contract. Run it on real
              data, then tweak the step params and re-run to verify or experiment.
            </p>
            {!status?.ready && (
              <p className="hint">
                Ingest the source GL (input), the mapping workbook (mapping), and the loader
                (output) first.
              </p>
            )}
          </div>
        )}
      </div>
      {sketch?.explanation && (
        <div className="pipeline-explanation">
          <h2>Why this pipeline</h2>
          <ReactMarkdown>{sketch.explanation}</ReactMarkdown>
          {sketch.sources.length > 0 && (
            <div className="sources">
              {uniqueSources(sketch.sources).map((s) => (
                <span key={`${s.category}-${s.sheet}`} className="source-chip" title={`${s.category} · relevance ${s.score}`}>
                  {s.category}:{s.sheet}
                </span>
              ))}
            </div>
          )}
          <div className="meta">
            {sketch.latencyMs} ms · {sketch.model}
          </div>
        </div>
      )}
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
      <section className="validate-mapping">
        <h2>Validate Mapping</h2>
        <button
          onClick={async () => {
            try {
              const result = await api.validateMapping();
              console.log("Validation result:", result);
            } catch (error) {
              console.error("Validation failed:", error);
            }
          }}
        >
          Validate Mapping
        </button>
      </section>

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
