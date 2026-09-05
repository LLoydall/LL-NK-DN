import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { config } from "../config.js";
import type {
  OperatorCatalog,
  PipelineDoc,
  PipelineValidateResponse,
} from "../engineClient.js";
import { log } from "../observability.js";
import { formatContext } from "./graph.js";
import { resolvedModelNames } from "./models.js";
import { NO_PIPELINE_CONTEXT_ANSWER, PIPELINE_PROMPT } from "./prompts.js";
import type { RuleIndex, SearchHit } from "./store.js";

/**
 * Pipeline sketching: the LLM's best guess at how input became output,
 * expressed as a DAG of the deterministic engine's atomic operators. The
 * graph is retrieve (per category) -> draft -> engine-validate, with one
 * repair loop back to draft when the engine rejects the pipeline. The user
 * then runs/experiments with the result via POST /api/pipeline/run.
 */

/** Engine surface the graph needs; injected so tests can fake it. */
export interface PipelineEngine {
  getOperators(): Promise<{ operators: OperatorCatalog }>;
  validatePipeline(pipeline: unknown): Promise<PipelineValidateResponse>;
}

export interface PipelineGraphDeps {
  index: RuleIndex;
  model: BaseChatModel;
  engine: PipelineEngine;
}

export interface PipelineSketchResult {
  pipeline: PipelineDoc | null;
  explanation: string;
  validation: { ok: boolean; errors: string[] };
  sources: Array<{ sheet: string; category: string; score: number }>;
  model: string;
  latencyMs: number;
  noRelevantContext: boolean;
}

// Shape check before bothering the engine: catches truncated/model-invented
// JSON. The engine remains the authority on operator/parameter validity.
const pipelineDocSchema = z.object({
  name: z.string().optional(),
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        op: z.string().min(1),
        uses: z.array(z.string()).optional(),
        params: z.record(z.unknown()).default({}),
      }),
    )
    .min(1),
});

// Input/output retrieval is narrower than mapping: their overview cards are
// what matters (column contracts), not row chunks.
const SKETCH_CATEGORY_K = 4;
// Initial draft + one repair attempt.
const MAX_DRAFT_ATTEMPTS = 2;

const PipelineState = Annotation.Root({
  question: Annotation<string>(),
  hits: Annotation<SearchHit[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  context: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  catalog: Annotation<OperatorCatalog | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  draftText: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  feedback: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  attempts: Annotation<number>({ reducer: (_prev, next) => next, default: () => 0 }),
  pipeline: Annotation<PipelineDoc | null>({ reducer: (_prev, next) => next, default: () => null }),
  explanation: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
  errors: Annotation<string[]>({ reducer: (_prev, next) => next, default: () => [] }),
});

function messageText(message: BaseMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((c) => ("text" in c ? c.text : "")).join("");
}

function extractFenced(text: string, lang: string): string | null {
  const match = text.match(new RegExp("```" + lang + "\\s*\\n([\\s\\S]*?)```"));
  return match ? match[1].trim() : null;
}

function parseDraft(draft: string): {
  pipeline: PipelineDoc | null;
  explanation: string;
  parseError: string | null;
} {
  // Fall back to the whole response when the model skips the fence.
  const jsonBlock = extractFenced(draft, "json") ?? draft.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlock);
  } catch {
    return { pipeline: null, explanation: "", parseError: "model output was not valid JSON" };
  }
  const shape = pipelineDocSchema.safeParse(parsed);
  if (!shape.success) {
    const issue = shape.error.issues[0];
    return {
      pipeline: null,
      explanation: "",
      parseError: `pipeline JSON did not match the expected shape (${issue?.path.join(".")}: ${issue?.message})`,
    };
  }
  return { pipeline: shape.data, explanation: extractFenced(draft, "markdown") ?? "", parseError: null };
}

export function buildPipelineGraph(deps: PipelineGraphDeps) {
  /**
   * Retrieve from all three categories separately: the rules (mapping), what
   * the source data looks like (input), and the contract it must satisfy
   * (output). A single unfiltered search would drown the input/output cards
   * in mapping rows.
   */
  async function retrieve(state: typeof PipelineState.State) {
    const [mappingHits, inputHits, outputHits] = await Promise.all([
      deps.index.search(state.question, config.TOP_K, config.SCORE_THRESHOLD, {
        category: "mapping",
      }),
      deps.index.search(state.question, SKETCH_CATEGORY_K, config.SCORE_THRESHOLD, {
        category: "input",
      }),
      deps.index.search(state.question, SKETCH_CATEGORY_K, config.SCORE_THRESHOLD, {
        category: "output",
      }),
    ]);
    const hits = [...mappingHits, ...inputHits, ...outputHits];
    log("pipeline_retrieve", {
      question: state.question.slice(0, 120),
      mapping: mappingHits.length,
      input: inputHits.length,
      output: outputHits.length,
    });
    if (hits.length === 0) {
      // Same guardrail as chat: no context -> no LLM call, honest answer.
      return { hits, context: "", explanation: NO_PIPELINE_CONTEXT_ANSWER };
    }
    const { operators } = await deps.engine.getOperators();
    return { hits, context: formatContext(hits), catalog: operators };
  }

  async function draftPipeline(state: typeof PipelineState.State) {
    const feedback = state.feedback
      ? `\n\nYour previous draft failed validation:\n${state.feedback}\nFix these errors and return a corrected pipeline.`
      : "";
    const chain = PIPELINE_PROMPT.pipe(deps.model);
    const response = await chain.invoke({
      operatorCatalog: JSON.stringify(state.catalog, null, 2),
      context: state.context,
      question: state.question,
      feedback,
    });
    return { draftText: messageText(response), attempts: state.attempts + 1 };
  }

  async function validate(state: typeof PipelineState.State) {
    const { pipeline, explanation, parseError } = parseDraft(state.draftText);
    let errors: string[];
    if (parseError) {
      errors = [parseError];
    } else {
      const validation = await deps.engine.validatePipeline(pipeline);
      errors = validation.ok ? [] : validation.errors;
    }
    log("pipeline_validate", {
      attempt: state.attempts,
      ok: errors.length === 0,
      errors: errors.length,
    });
    if (errors.length > 0 && state.attempts < MAX_DRAFT_ATTEMPTS) {
      // Repair loop: hand the errors back to the model exactly once.
      return { errors, feedback: errors.join("\n") };
    }
    return { pipeline, explanation, errors };
  }

  return new StateGraph(PipelineState)
    .addNode("retrieve", retrieve)
    .addNode("draft", draftPipeline)
    .addNode("validate", validate)
    .addEdge(START, "retrieve")
    .addConditionalEdges("retrieve", (state) => (state.context ? "draft" : END))
    .addEdge("draft", "validate")
    .addConditionalEdges("validate", (state) =>
      state.errors.length > 0 && state.attempts < MAX_DRAFT_ATTEMPTS ? "draft" : END,
    )
    .compile();
}

export type PipelineGraph = ReturnType<typeof buildPipelineGraph>;

export async function runPipelineSketch(
  graph: PipelineGraph,
  question: string,
): Promise<PipelineSketchResult> {
  const start = process.hrtime.bigint();
  const result = await graph.invoke({ question });
  const latencyMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);

  const hits: SearchHit[] = result.hits ?? [];
  const sources = hits.map((h) => ({
    sheet: String(h.document.metadata.sheet),
    category: String(h.document.metadata.category ?? "unknown"),
    score: Math.round(h.score * 1000) / 1000,
  }));
  const pipeline: PipelineDoc | null = result.pipeline ?? null;
  const errors: string[] = result.errors ?? [];
  log("pipeline_sketch", {
    latencyMs,
    steps: pipeline?.steps.length ?? 0,
    valid: pipeline !== null && errors.length === 0,
  });
  return {
    pipeline,
    explanation: result.explanation ?? "",
    validation: { ok: pipeline !== null && errors.length === 0, errors },
    sources,
    model: resolvedModelNames(config).chat,
    latencyMs,
    noRelevantContext: hits.length === 0,
  };
}
