import { Document } from "@langchain/core/documents";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import { buildChatGraph, runChat, toChatHistory } from "./graph.js";
import { NO_CONTEXT_ANSWER } from "./prompts.js";
import type { RuleIndex } from "./store.js";

function fakeIndex(hits: Array<{ document: Document; score: number }>): RuleIndex {
  return {
    search: vi.fn(async () => hits),
    indexMetadata: { sourceLabel: "test workbook.xlsx" },
  } as unknown as RuleIndex;
}

describe("chat graph", () => {
  it("answers with retrieved context and reports sheet sources", async () => {
    const index = fakeIndex([
      {
        document: new Document({
          pageContent: "Sheet: LE Mapping\n\nSource LE: Fund A | Target LE: LE-001",
          metadata: { sheet: "LE Mapping", part: 1, category: "mapping", chunkIndex: 0 },
        }),
        score: 0.9,
      },
    ]);
    const model = new FakeListChatModel({
      // First response is consumed by query rewriting, second by the answer.
      responses: ["unmapped legal entities\nlegal entity crosswalk", "Fund A maps to LE-001 via [LE Mapping]."],
    });
    const graph = buildChatGraph({ index, model });

    const result = await runChat(graph, "what does Fund A map to?", []);
    expect(result.answer).toBe("Fund A maps to LE-001 via [LE Mapping].");
    expect(result.sources).toEqual([{ sheet: "LE Mapping", category: "mapping", score: 0.9 }]);
    expect(result.noRelevantContext).toBe(false);
    expect(result.model).toBeTruthy();
    // Original question + two rewrite variants; the duplicate hit is merged.
    expect(index.search).toHaveBeenCalledTimes(3);
  });

  it("short-circuits without calling the LLM when nothing is retrieved", async () => {
    const index = fakeIndex([]);
    const model = new FakeListChatModel({ responses: ["should never be used"] });
    const graph = buildChatGraph({ index, model });

    const result = await runChat(graph, "unanswerable?", []);
    expect(result.answer).toBe(NO_CONTEXT_ANSWER);
    expect(result.sources).toEqual([]);
    expect(result.noRelevantContext).toBe(true);
  });
});

describe("toChatHistory", () => {
  it("maps wire roles to message classes and drops empties", () => {
    const history = toChatHistory([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "" },
    ]);
    expect(history).toHaveLength(2);
    expect(history[0]._getType()).toBe("human");
    expect(history[1]._getType()).toBe("ai");
  });

  it("tolerates missing history", () => {
    expect(toChatHistory(undefined)).toEqual([]);
  });
});
