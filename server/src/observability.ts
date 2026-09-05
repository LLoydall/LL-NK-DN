import type { NextFunction, Request, Response } from "express";

/**
 * Minimal structured logging. Deliberately dependency-free: JSON lines keep it
 * greppable locally and machine-parseable when shipped to a log aggregator.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  process.stdout.write(line + "\n");
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  log(event, {
    ...fields,
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Express middleware: one JSON log line per request with latency. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    log("http_request", {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    });
  });
  next();
}
