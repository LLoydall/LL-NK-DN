import path from "node:path";
import { existsSync } from "node:fs";
import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "./config.js";
import { EngineUnavailableError } from "./engineClient.js";
import { logError, requestLogger } from "./observability.js";
import { MissingCredentialError } from "./rag/models.js";
import { QdrantUnavailableError } from "./rag/store.js";
import { IndexNotReadyError, MigrationService } from "./service.js";

const ingestSchema = z.object({
  path: z.string().min(1).max(1_000),
});

const chatSchema = z.object({
  question: z.string().min(1).max(config.MAX_QUESTION_CHARS),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) }))
    .max(50)
    .optional(),
});

const reviewCheckSchema = z.object({
  payload: z.unknown(),
});

export function createApp(service: MigrationService): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(cors());
  app.use(requestLogger);

  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api", apiLimiter);

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/api/status", async (_req: Request, res: Response) => {
    res.json(await service.status());
  });

  app.post("/api/ingest", async (req: Request, res: Response) => {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await service.ingest(parsed.data.path);
      res.json(result);
    } catch (error) {
      logError("ingest_failed", error);
      const message = error instanceof Error ? error.message : "Ingestion failed";
      const status =
        error instanceof MissingCredentialError || error instanceof QdrantUnavailableError
          ? 503
          : 422;
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/chat", async (req: Request, res: Response) => {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await service.chat(parsed.data.question, parsed.data.history);
      res.json({
        answer: result.answer,
        sources: result.sources,
        latencyMs: result.latencyMs,
        model: result.model,
      });
    } catch (error) {
      if (error instanceof IndexNotReadyError) {
        res.status(409).json({ error: error.message });
        return;
      }
      logError("chat_failed", error);
      const message = error instanceof Error ? error.message : "Chat failed";
      const status =
        error instanceof MissingCredentialError || error instanceof QdrantUnavailableError
          ? 503
          : 500;
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/review/check", async (req: Request, res: Response) => {
    const parsed = reviewCheckSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await service.reviewCheck(parsed.data.payload);
      res.json(result);
    } catch (error) {
      logError("review_check_failed", error);
      if (error instanceof EngineUnavailableError) {
        res.status(503).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "Engine check failed";
      res.status(502).json({ error: message });
    }
  });

  app.delete("/api/index", async (_req: Request, res: Response) => {
    await service.clearIndex();
    res.json({ cleared: true });
  });

  // In production builds the web app is served from ./public (see Dockerfile).
  const publicDir = path.resolve("public");
  if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(publicDir, "index.html"));
    });
  }

  return app;
}
