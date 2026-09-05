import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { Document } from "@langchain/core/documents";
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { config } from "../config.js";
import { log } from "../observability.js";
import { resolvedModelNames } from "./models.js";
import type { RuleIndex, SearchHit } from "./store.js";
import { ANSWER_PROMPT, NO_CONTEXT_ANSWER } from "./prompts.js";

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
  async function retrieve(state: typeof GraphState.State) {
    const hits = await deps.index.search(state.question, config.TOP_K, config.SCORE_THRESHOLD);
    log("retrieve", {
      question: state.question.slice(0, 120),
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
