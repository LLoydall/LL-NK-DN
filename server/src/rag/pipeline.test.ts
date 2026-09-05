import { Document } from "@langchain/core/documents";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import type { PipelineDoc } from "../engineClient.js";
import { NO_PIPELINE_CONTEXT_ANSWER } from "./prompts.js";
import {
  buildPipelineGraph,
  runPipelineSketch,
  type PipelineEngine,
} from "./pipeline.js";
import type { RuleIndex, SearchHit } from "./store.js";

const HITS: SearchHit[] = [
  {
    document: new Document({
      pageContent: "Sheet: LE Mapping\n\nSource LE: Fund A | Target LE: LE-001",
      metadata: { sheet: "LE Mapping", part: 1, category: "mapping", chunkIndex: 0 },
    }),
    score: 0.9,
  },
  {
    document: new Document({
      pageContent: "Sheet overview: Investor-Level GL",
      metadata: { sheet: "Investor-Level GL", part: 0, category: "input", chunkIndex: 0 },
    }),
    score: 0.8,
  },
];

function fakeIndex(hits: SearchHit[]): RuleIndex {
  return {
    // Honour the category filter like the real RuleIndex does.
    search: vi.fn(
      async (
        _query: string,
        _k: number,
        _minScore: number,
        filter?: { category?: string },
      ) =>
        filter?.category
          ? hits.filter((h) => h.document.metadata.category === filter.category)
          : hits,
    ),
    indexMetadata: { sourceLabel: "test workbook.xlsx" },
  } as unknown as RuleIndex;
}

const VALID_PIPELINE: PipelineDoc = {
  name: "gl to loader sketch",
  steps: [
    { id: "gl", op: "read_sheet", params: { source: "gl.xlsx", sheet: "Investor-Level GL" } },
    {
      id: "le",
      op: "lookup",
      uses: ["gl"],
      params: { table: "legal_entity", on: ["Legal Entity"], select: { "LE ID": "target" } },
    },
  ],
};

function draftText(pipeline: unknown, explanation = "read the GL, then map entities"): string {
  return "```json\n" + JSON.stringify(pipeline) + "\n```\n```markdown\n" + explanation + "\n```";
}

function fakeEngine(validateResults: Array<{ ok: boolean; errors: string[] }>): PipelineEngine {
  const calls = [...validateResults];
  return {
    getOperators: vi.fn(async () => ({ operators: { lookup: { kind: "transform" } } })),
    validatePipeline: vi.fn(async () => calls.shift() ?? { ok: true, errors: [] }),
  };
}

describe("pipeline sketch graph", () => {
  it("retrieves per category, drafts a pipeline, and validates it with the engine", async () => {
    const index = fakeIndex(HITS);
    const engine = fakeEngine([{ ok: true, errors: [] }]);
    const model = new FakeListChatModel({ responses: [draftText(VALID_PIPELINE)] });
    const graph = buildPipelineGraph({ index, model, engine });

    const result = await runPipelineSketch(graph, "how did the GL become the loader?");

    expect(result.pipeline).toEqual(VALID_PIPELINE);
    expect(result.explanation).toBe("read the GL, then map entities");
    expect(result.validation).toEqual({ ok: true, errors: [] });
    expect(result.noRelevantContext).toBe(false);
    expect(result.sources.map((s) => s.category)).toEqual(["mapping", "input"]);
    // One search per category, each with the category filter applied.
    expect(index.search).toHaveBeenCalledTimes(3);
    const filters = vi.mocked(index.search).mock.calls.map((c) => c[3]);
    expect(filters).toEqual([
      { category: "mapping" },
      { category: "input" },
      { category: "output" },
    ]);
    // The catalog is fetched so the prompt can quote it.
    expect(engine.getOperators).toHaveBeenCalledOnce();
  });

  it("short-circuits without an LLM or engine call when nothing is retrieved", async () => {
    const index = fakeIndex([]);
    const engine = fakeEngine([]);
    const model = new FakeListChatModel({ responses: ["should never be used"] });
    const graph = buildPipelineGraph({ index, model, engine });

    const result = await runPipelineSketch(graph, "unanswerable?");

    expect(result.pipeline).toBeNull();
    expect(result.explanation).toBe(NO_PIPELINE_CONTEXT_ANSWER);
    expect(result.noRelevantContext).toBe(true);
    expect(engine.getOperators).not.toHaveBeenCalled();
    expect(engine.validatePipeline).not.toHaveBeenCalled();
  });

  it("repairs once when the engine rejects the first draft", async () => {
    const index = fakeIndex(HITS);
    const engine = fakeEngine([
      { ok: false, errors: ["unknown op: lookp"] },
      { ok: true, errors: [] },
    ]);
    const model = new FakeListChatModel({
      responses: [draftText({ steps: [{ id: "x", op: "lookp", params: {} }] }), draftText(VALID_PIPELINE)],
    });
    const graph = buildPipelineGraph({ index, model, engine });

    const result = await runPipelineSketch(graph, "sketch it");

    expect(engine.validatePipeline).toHaveBeenCalledTimes(2);
    expect(result.pipeline).toEqual(VALID_PIPELINE);
    expect(result.validation).toEqual({ ok: true, errors: [] });
  });

  it("gives up after one repair and reports the validation errors", async () => {
    const index = fakeIndex(HITS);
    const engine = fakeEngine([
      { ok: false, errors: ["unknown op: lookp"] },
      { ok: false, errors: ["unknown op: lookp"] },
    ]);
    const model = new FakeListChatModel({
      responses: [draftText(VALID_PIPELINE), draftText(VALID_PIPELINE)],
    });
    const graph = buildPipelineGraph({ index, model, engine });

    const result = await runPipelineSketch(graph, "sketch it");

    expect(engine.validatePipeline).toHaveBeenCalledTimes(2);
    expect(result.validation).toEqual({ ok: false, errors: ["unknown op: lookp"] });
  });

  it("treats unparseable model output as a repairable failure", async () => {
    const index = fakeIndex(HITS);
    const engine = fakeEngine([{ ok: true, errors: [] }]);
    const model = new FakeListChatModel({
      responses: ["sorry, I cannot help", draftText(VALID_PIPELINE)],
    });
    const graph = buildPipelineGraph({ index, model, engine });

    const result = await runPipelineSketch(graph, "sketch it");

    // First draft never reached the engine (no JSON to validate).
    expect(engine.validatePipeline).toHaveBeenCalledOnce();
    expect(result.pipeline).toEqual(VALID_PIPELINE);
    expect(result.validation.ok).toBe(true);
  });
});
