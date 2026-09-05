import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { Document } from "@langchain/core/documents";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { config } from "../config.js";
import { log } from "../observability.js";
import { resolvedModelNames } from "./models.js";
import { ANSWER_PROMPT, NO_CONTEXT_ANSWER, QUERY_REWRITE_PROMPT } from "./prompts.js";
import { MAX_CHUNKS_PER_SHEET, type RuleIndex, type SearchHit } from "./store.js";

/**
 * Agent state for the RAG graph. Kept deliberately small: the graph is
 * retrieve -> generate, but modelled as a LangGraph state machine so extra
 * nodes (query rewriting, retrieval grading, engine tool calls) slot in
 * without restructuring the service layer.
 */
const GraphState = Annotation.Root({
  question: Annotation<string>(),
  history: Annotation<BaseMessage[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  hits: Annotation<SearchHit[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  answer: Annotation<string>(),
});

export interface ChatResult {
  answer: string;
  sources: Array<{ sheet: string; score: number }>;
  model: string;
  latencyMs: number;
  noRelevantContext: boolean;
}

export interface ChatGraphDeps {
  index: RuleIndex;
  model: BaseChatModel;
}

function formatContext(hits: SearchHit[]): string {
  let budget = config.MAX_CONTEXT_CHARS;
  const blocks: string[] = [];
  for (const hit of hits) {
    const block = `--- ${String(hit.document.metadata.sheet)} (relevance ${hit.score.toFixed(2)}) ---\n${hit.document.pageContent}`;
    if (block.length > budget) break;
    blocks.push(block);
    budget -= block.length;
  }
  return blocks.join("\n\n");
}

export function buildChatGraph(deps: ChatGraphDeps) {
  /**
   * Expand the question into search variants (one cheap LLM call). Recall is
   * phrasing-sensitive — the workbook's vocabulary ("mapping gaps") often
   * differs from the user's ("no mapping") — so a single embedding search
   * misses the right sheet. Falls back to the bare question on any failure.
   */
  async function rewriteQueries(question: string): Promise<string[]> {
    try {
      const chain = QUERY_REWRITE_PROMPT.pipe(deps.model);
      const response = await chain.invoke({ question });
      const text =
        typeof response.content === "string"
          ? response.content
          : response.content.map((c) => ("text" in c ? c.text : "")).join("");
      return text
        .split("\n")
        .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
        .filter((line) => line.length > 0 && line.toLowerCase() !== question.toLowerCase())
        .slice(0, 3);
    } catch (error) {
      log("query_rewrite_failed", { error: String(error) });
      return [];
    }
  }

  async function retrieve(state: typeof GraphState.State) {
    const queries = [state.question, ...(await rewriteQueries(state.question))];
    // Merge hits across variants, keeping each chunk's best score.
    const merged = new Map<string, SearchHit>();
    for (const query of queries) {
      const hits = await deps.index.search(query, config.TOP_K, config.SCORE_THRESHOLD);
      for (const hit of hits) {
        const prev = merged.get(hit.document.pageContent);
        if (!prev || hit.score > prev.score) merged.set(hit.document.pageContent, hit);
      }
    }
    // Re-apply the per-sheet cap across the merged set, best score first.
    const perSheet = new Map<string, number>();
    const hits = [...merged.values()]
      .sort((a, b) => b.score - a.score)
      .filter((hit) => {
        const sheet = String(hit.document.metadata.sheet);
        const count = perSheet.get(sheet) ?? 0;
        if (count >= MAX_CHUNKS_PER_SHEET) return false;
        perSheet.set(sheet, count + 1);
        return true;
      })
      .slice(0, config.TOP_K);
    log("retrieve", {
      question: state.question.slice(0, 120),
      queries: queries.length,
      hits: hits.length,
      topScore: hits[0]?.score ?? null,
    });
    return { hits };
  }

  async function generate(state: typeof GraphState.State) {
    // Guardrail: no relevant context -> no LLM call, honest canned answer.
    if (state.hits.length === 0) {
      return { answer: NO_CONTEXT_ANSWER };
    }
    const context = formatContext(state.hits);
    const sourceLabel = deps.index.indexMetadata?.sourceLabel ?? "the ingested workbook";
    const history = state.history.slice(-config.MAX_HISTORY_MESSAGES);
    const chain = ANSWER_PROMPT.pipe(deps.model);
    const response = await chain.invoke({
      sourceLabel,
      context,
      history,
      question: state.question,
    });
    const answer =
      typeof response.content === "string"
        ? response.content
        : response.content.map((c) => ("text" in c ? c.text : "")).join("");
    return { answer };
  }

  return new StateGraph(GraphState)
    .addNode("retrieve", retrieve)
    .addNode("generate", generate)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "generate")
    .addEdge("generate", END)
    .compile();
}

export type ChatGraph = ReturnType<typeof buildChatGraph>;

/** Convert wire-format history ([{role, content}]) to LangChain messages. */
export function toChatHistory(
  history: Array<{ role: string; content: string }> | undefined,
): BaseMessage[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => typeof m?.content === "string" && m.content.length > 0)
    .map((m) => (m.role === "assistant" ? new AIMessage(m.content) : new HumanMessage(m.content)));
}

export async function runChat(
  graph: ChatGraph,
  question: string,
  history: BaseMessage[],
): Promise<ChatResult> {
  const start = process.hrtime.bigint();
  const result = await graph.invoke({ question, history });
  const latencyMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);

  const hits: SearchHit[] = result.hits ?? [];
  const sources = hits.map((h) => ({
    sheet: String(h.document.metadata.sheet),
    score: Math.round(h.score * 1000) / 1000,
  }));
  log("chat_answer", {
    latencyMs,
    sources: sources.length,
    usedLlm: hits.length > 0,
  });
  return {
    answer: result.answer,
    sources,
    model: resolvedModelNames(config).chat,
    latencyMs,
    noRelevantContext: hits.length === 0,
  };
}
