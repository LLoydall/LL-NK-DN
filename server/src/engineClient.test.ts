import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkBatch,
  clearUploads,
  EngineUnavailableError,
  getOperators,
  runPipeline,
  uploadData,
  validatePipeline,
} from "./engineClient.js";

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

describe("pipeline endpoints", () => {
  const pipeline = { steps: [{ id: "gl", op: "read_sheet", params: {} }] };

  it("getOperators GETs /operators", async () => {
    const catalog = { operators: { lookup: { kind: "transform" } } };
    const fetchMock = vi.fn(async () => jsonResponse(catalog));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getOperators();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://localhost:8081/operators");
    expect(init?.method ?? "GET").toBe("GET");
    expect(result).toEqual(catalog);
  });

  it("validatePipeline POSTs the pipeline to /pipeline/validate", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, errors: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await validatePipeline(pipeline);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://localhost:8081/pipeline/validate");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ pipeline });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("runPipeline POSTs the pipeline and row cap to /pipeline/run", async () => {
    const engineBody = { ok: true, steps: [{ id: "gl", status: "ok", rowCount: 50 }] };
    const fetchMock = vi.fn(async () => jsonResponse(engineBody));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runPipeline(pipeline, 50);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://localhost:8081/pipeline/run");
    expect(JSON.parse(String(init?.body))).toEqual({ pipeline, max_rows: 50 });
    expect(result).toEqual(engineBody);
  });

  it("runPipeline throws EngineUnavailableError when the engine is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(runPipeline(pipeline)).rejects.toBeInstanceOf(EngineUnavailableError);
  });
});

describe("data upload endpoints", () => {
  it("uploadData POSTs raw bytes with the filename and mapping flag", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ ok: true, name: "gl.xlsx", bytes: 3 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadData("gl.xlsx", Buffer.from([1, 2, 3]), { asMapping: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "http://localhost:8081/data/upload?name=gl.xlsx&as_mapping=true",
    );
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(init?.body as Uint8Array)).toEqual(new Uint8Array([1, 2, 3]));
    expect(result).toEqual({ ok: true, name: "gl.xlsx", bytes: 3 });
  });

  it("uploadData omits the mapping flag by default", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadData("a file.xlsx", Buffer.from([1]));

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://localhost:8081/data/upload?name=a+file.xlsx");
  });

  it("clearUploads DELETEs /data/uploads", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, removed: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    await clearUploads();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://localhost:8081/data/uploads");
    expect(init?.method).toBe("DELETE");
  });

  it("uploadData throws EngineUnavailableError when the engine is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(uploadData("gl.xlsx", Buffer.from([1]))).rejects.toBeInstanceOf(
      EngineUnavailableError,
    );
  });
});
