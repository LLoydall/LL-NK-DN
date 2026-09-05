# AGENTS.md — guidance for AI coding agents working in this repo

## What this is

YLookup hackathon project: a pipeline for migrating an investor-level GL into a
target fund-accounting system's loader format (dataset
`sample-data-and-call-transcripts/02-investor-level-gl-to-loader`).

```
RAG (find mapping rules/crosswalks) → Engine (deterministic checks) → LLM (explain) → Human (approve)
```

## Layout

- `server/` — Node.js + TypeScript API (Express). LangChain/LangGraph RAG lives here.
  - `src/ingestion/` — workbook (.xlsx) loading (repo-local path or multipart upload via
    multer) and chunking of the mapping/reference sheets. Ingest supports `append` (grow
    the corpus) and `replace` modes.
  - `src/rag/` — Qdrant vector store (`store.ts`), LangGraph chat graph (`graph.ts`),
    prompts (`prompts.ts`), Vertex AI model factories (`models.ts`).
  - `src/engineClient.ts` — HTTP client for the Python engine.
  - `src/service.ts` — application service wiring; instantiated per-process (and per-test).
  - `src/app.ts` — HTTP layer only; keep business logic out of it.
- `web/` — React + Vite frontend, proxies `/api` to the server in dev. Tabs: Ask (chat),
  Review queue (human approval step).
- `engine/` — Python FastAPI deterministic engine. Pure checks only, no LLM calls.
  HTTP contract is a stub (`GET /healthz`, `POST /check`); `app/mapping.py` loads
  the dataset 02 reference workbook at import from `MAPPING_WORKBOOK` (compose
  mounts it read-only at `/data`; local default resolves to the repo copy).
- `deploy/k8s/` — GKE manifests: qdrant (StatefulSet + PVC), engine, app (LoadBalancer).
- `Dockerfile` (root) — app image (web + server). `engine/Dockerfile` — engine image.
- `cloudbuild.yaml` — Cloud Build: build/push both images to Artifact Registry, deploy to GKE.
- `sample-data-and-call-transcripts/` — raw anonymised datasets; never modified, never
  baked into images.

## Commands

- Server: `cd server && npm install && npm run dev` / `npm test` / `npm run typecheck` / `npm run build`.
- Web: `cd web && npm install && npm run dev` / `npm run build`.
- Engine: `cd engine && pip install -r requirements.txt && uvicorn app.main:app --port 8081`.
- Local backing services: `docker compose up qdrant engine`.
- Deploy: `gcloud builds submit --project=priv-mkt-hack26lon-3752`.
- Or use the `Makefile` (`make help`): `make backend`, `make frontend`, `make services`,
  `make check`, `make deploy`.

## Conventions

- TypeScript strict mode everywhere; ESM with `.js` import suffixes in the server (NodeNext).
- Tests are Vitest, colocated as `*.test.ts`, and must not call external APIs — use
  fakes from `@langchain/core/utils/testing`.
- Config only via `server/src/config.ts` (zod-validated env). Never read `process.env` elsewhere.
- Prompts live in `server/src/rag/prompts.ts` so changes are reviewable in git.
- Model access is Vertex AI (project `priv-mkt-hack26lon-3752`) via ADC: chat defaults to a
  first-party Gemini publisher model (no deployment needed); setting `VERTEX_CHAT_ENDPOINT_ID`
  switches chat to a deployed Model Garden endpoint (e.g. Qwen) via its OpenAI-compatible
  route. Embeddings via `@langchain/google-vertexai`. Vectors live in Qdrant, not on disk.
- Keep changes minimal and match surrounding style; don't add dependencies without
  checking whether an existing one already does the job.

## Definition of done

`cd server && npm test && npm run typecheck && npm run build`, `cd web && npm run build`,
and `python3 -m py_compile engine/app/main.py` pass before declaring a change complete.
