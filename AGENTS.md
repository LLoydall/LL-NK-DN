# AGENTS.md — guidance for AI coding agents working in this repo

## What this is

YLookup hackathon project: a pipeline for migrating an investor-level GL into a
target fund-accounting system's loader format (dataset
`sample-data-and-call-transcripts/02-investor-level-gl-to-loader`). Its job is to
explain *how input got translated to output*.

```
RAG (find mapping rules/crosswalks) → Engine (deterministic checks) → LLM (explain) → Human (approve)
```

## Layout

- `server/` — Node.js + TypeScript API (Express). LangChain/LangGraph RAG lives here.
  - `src/ingestion/` — workbook (.xlsx) loading (repo-local path or multipart upload via
    multer) and chunking of the mapping/reference sheets. Ingest supports `append` (grow
    the corpus) and `replace` modes, and a per-workbook **category**: `input`
    (source-system data), `mapping` (translation rules/crosswalks, the default), or
    `output` (target-format artifacts). Every chunk carries the category in its Qdrant
    payload; `SHEET_CATEGORIES` in `xlsx.ts` overrides it per sheet (the Upload
    Template sheet is `output` even inside the mapping workbook). Only mapping
    sheets embed row documents — input/output sheets embed as a single overview
    card (columns, row count, sample rows); row-level truth for data sheets
    lives in the engine, not the vector store. At ingest the raw
    workbook bytes are also pushed to the engine (`uploadData`; reported as
    `engineSync` in the response) so pipelines can verify against them; a mapping
    workbook with the full reference sheet set additionally reloads the engine's
    crosswalk tables.
  - `src/rag/` — Qdrant vector store (`store.ts`; `search` accepts a category filter),
    LangGraph chat graph (`graph.ts`), pipeline-sketch graph (`pipeline.ts`),
    prompts (`prompts.ts`), Vertex AI model factories (`models.ts`).
  - `src/engineClient.ts` — HTTP client for the Python engine (`/check`,
    `/validate_mapping`, plus the pipeline endpoints below).
  - `src/service.ts` — application service wiring; instantiated per-process (and per-test).
  - `src/app.ts` — HTTP layer only; keep business logic out of it.
- `web/` — React + Vite frontend, proxies `/api` to the server in dev. Tabs: Ask (chat),
  Pipeline (LLM-sketched operator DAG on a React Flow canvas — run/edit/re-run), and
  Review queue (human approval step).
- `engine/` — Python FastAPI deterministic engine. Pure checks only, no LLM calls.
  `app/mapping.py` builds the crosswalk tables from the dataset 02 reference
  workbook (`MAPPING_WORKBOOK`) via `load_workbook()` — atomic and re-callable
  at runtime; if the workbook is missing (e.g. GKE) the engine boots anyway and
  `lookup` errors clearly until a mapping workbook is uploaded. `DATA_DIR` is
  the dataset root, `UPLOADS_DIR` the runtime-upload root (compose mounts the
  dataset read-only at `/data` plus a named volume at `/uploads`; local
  defaults resolve to the repo, uploads to `data/uploads/`).
  - `app/operators.py` — catalog of ~23 atomic, composable operators (row math,
    lexical, crosswalk `lookup`, table ops, `assert_*` terminal checks) as pure
    DataFrame functions. `read_sheet` resolves workbooks inside `UPLOADS_DIR`
    first, then `DATA_DIR` (uploads win).
  - `app/pipeline.py` — `OPERATOR_CATALOG` (machine-readable spec; served verbatim
    via `GET /operators` and injected into the LLM prompt), `validate_pipeline`,
    `run_pipeline` (JSON step-DAG interpreter; `uses` may only reference earlier
    steps). Endpoints: `GET /operators`, `POST /pipeline/validate`,
    `POST /pipeline/run` (row-capped samples per step).
  - Upload endpoints: `POST /data/upload?name=&as_mapping=` (raw bytes; stores
    under `UPLOADS_DIR`, optionally reloads crosswalk tables),
    `GET /data/uploads`, `DELETE /data/uploads`.
  - `/pipeline/run` reads data only from the two roots above — in GKE that means
    uploaded workbooks (the sample dataset isn't mounted in-cluster); locally
    and in compose both roots work.
- `deploy/k8s/` — GKE manifests: qdrant (StatefulSet + PVC), engine (Deployment +
  uploads PVC), app (ClusterIP only, no public LB — access via
  `kubectl port-forward svc/app 8080:80`).
- `Dockerfile` (root) — app image (web + server). `engine/Dockerfile` — engine image.
- `cloudbuild.yaml` — Cloud Build: build/push both images to Artifact Registry, deploy to GKE.
- `sample-data-and-call-transcripts/` — raw anonymised datasets; never modified, never
  baked into images.

## Commands

- Server: `cd server && npm install && npm run dev` / `npm test` / `npm run typecheck` / `npm run build`.
- Web: `cd web && npm install && npm run dev` / `npm run build`.
- Engine: `cd engine && pip install -r requirements.txt && uvicorn app.main:app --port 8081`;
  tests `cd engine && python3 -m pytest` (use a venv, e.g. `engine/.venv`).
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
- The engine's operator catalog is the single source of truth for pipeline
  validity — the LLM may only compose catalog operators, and the engine validates
  every sketch (one repair loop) before it reaches the user. No free-form code.
- Model access is Vertex AI (project `priv-mkt-hack26lon-3752`) via ADC: chat defaults to a
  first-party Gemini publisher model (no deployment needed); setting `VERTEX_CHAT_ENDPOINT_ID`
  switches chat to a deployed Model Garden endpoint (e.g. Qwen) via its OpenAI-compatible
  route. Embeddings via `@langchain/google-vertexai`. Vectors live in Qdrant, not on disk.
- Keep changes minimal and match surrounding style; don't add dependencies without
  checking whether an existing one already does the job. (`@xyflow/react` in `web/`
  is the sanctioned exception: it renders the pipeline node graph.)

## Definition of done

`cd server && npm test && npm run typecheck && npm run build`, `cd web && npm run build`,
`python3 -m py_compile engine/app/main.py`, and `cd engine && python3 -m pytest`
pass before declaring a change complete.

