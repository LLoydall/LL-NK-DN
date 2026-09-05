import path from "node:path";
import { existsSync } from "node:fs";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { config } from "./config.js";
import { EngineUnavailableError } from "./engineClient.js";
import { logError, requestLogger } from "./observability.js";
import { MissingCredentialError } from "./rag/models.js";
import { QdrantUnavailableError } from "./rag/store.js";
import { IndexNotReadyError, MigrationService } from "./service.js";

const modeSchema = z.enum(["append", "replace"]).default("append");

const categorySchema = z.enum(["input", "mapping", "output"]).default("mapping");

const ingestSchema = z.object({
  path: z.string().min(1).max(1_000),
  mode: modeSchema,
  category: categorySchema,
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

const pipelineSketchSchema = z.object({
  question: z.string().min(1).max(config.MAX_QUESTION_CHARS),
});

const pipelineRunSchema = z.object({
  pipeline: z.unknown(),
  maxRows: z.number().int().min(1).max(10_000).optional(),
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

  // Multipart uploads stay in memory; the size guard mirrors MAX_FILE_BYTES.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.MAX_FILE_BYTES },
  });

  // Multer passes non-multipart requests straight through, so one route can
  // serve both the upload flow (field `file`) and the JSON path flow (dev).
  app.post(
    "/api/ingest",
    (req: Request, res: Response, next: NextFunction) => {
      upload.single("file")(req, res, (error: unknown) => {
        if (!error) return next();
        const message =
          error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
            ? `Workbook is too large (limit ${config.MAX_FILE_BYTES} bytes)`
            : "Invalid multipart upload";
        res.status(400).json({ error: message });
      });
    },
    async (req: Request, res: Response) => {
      try {
        if (req.file) {
          const mode = modeSchema.safeParse(req.body?.mode);
          const category = categorySchema.safeParse(req.body?.category);
          if (!mode.success || !category.success) {
            res
              .status(400)
              .json({
                error:
                  'Invalid mode or category; expected mode "append"/"replace" and category "input"/"mapping"/"output"',
              });
            return;
          }
          res.json(
            await service.ingest(
              { buffer: req.file.buffer, originalname: req.file.originalname },
              mode.data,
              category.data,
            ),
          );
          return;
        }
        const parsed = ingestSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
          return;
        }
        res.json(
          await service.ingest({ path: parsed.data.path }, parsed.data.mode, parsed.data.category),
        );
      } catch (error) {
        logError("ingest_failed", error);
        const message = error instanceof Error ? error.message : "Ingestion failed";
        const status =
          error instanceof MissingCredentialError || error instanceof QdrantUnavailableError
            ? 503
            : 422;
        res.status(status).json({ error: message });
      }
    },
  );

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

  app.post("/api/pipeline/sketch", async (req: Request, res: Response) => {
    const parsed = pipelineSketchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await service.sketchPipeline(parsed.data.question);
      if (!result.pipeline) {
        // No usable pipeline even after the repair attempt — say so honestly.
        res.status(422).json({
          error: result.explanation || "The model did not produce a usable pipeline.",
          errors: result.validation.errors,
        });
        return;
      }
      res.json(result);
    } catch (error) {
      if (error instanceof IndexNotReadyError) {
        res.status(409).json({ error: error.message });
        return;
      }
      logError("pipeline_sketch_failed", error);
      const message = error instanceof Error ? error.message : "Pipeline sketch failed";
      const status =
        error instanceof MissingCredentialError ||
        error instanceof QdrantUnavailableError ||
        error instanceof EngineUnavailableError
          ? 503
          : 500;
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/pipeline/run", async (req: Request, res: Response) => {
    const parsed = pipelineRunSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
      return;
    }
    try {
      res.json(await service.runPipeline(parsed.data.pipeline, parsed.data.maxRows));
    } catch (error) {
      logError("pipeline_run_failed", error);
      if (error instanceof EngineUnavailableError) {
        res.status(503).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "Pipeline run failed";
      res.status(502).json({ error: message });
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

  app.get("/api/validate_mapping", async (_req: Request, res: Response) => {
    try {
      const result = await service.validateMapping();
      res.json(result);
    } catch (error) {
      logError("validate_mapping_failed", error);
      if (error instanceof EngineUnavailableError) {
        res.status(503).json({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : "Validation failed";
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
