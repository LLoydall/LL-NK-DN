import { afterEach, describe, expect, it, vi } from "vitest";
import { checkBatch, EngineUnavailableError } from "./engineClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkBatch", () => {
  it("POSTs the payload to the engine /check endpoint and parses the response", async () => {
    const engineBody = { status: "pass", checks: [{ name: "resolve_coa", status: "pass" }] };
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(engineBody),
    );
    vi.stubGlobal("fetch", fetchMock);

    const payload = { rows: [{ account: "1000", amount: 42 }] };
    const result = await checkBatch(payload);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://localhost:8081/check");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(payload);
    expect(result).toEqual(engineBody);
  });

  it("throws EngineUnavailableError when the engine is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(checkBatch({ rows: [] })).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  it("throws EngineUnavailableError on non-2xx engine responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "bad payload" }, 422)));
    await expect(checkBatch({ rows: [] })).rejects.toBeInstanceOf(EngineUnavailableError);
  });
});
