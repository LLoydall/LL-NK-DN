# LL-NK-DN — YLookup Hackathon Monorepo

Pipeline for migrating an investor-level GL into a target fund-accounting system's
loader format (dataset `sample-data-and-call-transcripts/02-investor-level-gl-to-loader`):

```
RAG (find mapping rules/crosswalks)
  → Deterministic engine (check the actual numbers)
  → LLM (explain the result)
  → Human (approve / review)
```

## Components

| Path | What |
|---|---|
| `server/` | Node/TS Express API — RAG over the loader workbook's mapping sheets (LangChain + Qdrant), Vertex AI Model Garden chat (Qwen) |
| `web/` | React + Vite UI — Ask (chat) and Review queue (human approval) |
| `engine/` | Python FastAPI deterministic engine (contract stub; checks to come) |
| `deploy/k8s/` | GKE manifests: qdrant, engine, app |
| `cloudbuild.yaml` | Cloud Build: build + push images, deploy to GKE |

## Quickstart (local)

Prereqs: Node ≥ 20, Python 3.12, Docker (for Qdrant), and ADC
(`gcloud auth application-default login --project=priv-mkt-hack26lon-3752`).

```sh
cp .env.example .env
docker compose up -d qdrant engine          # backing services
cd server && npm install && npm run dev     # API on :8080
cd web && npm install && npm run dev        # UI on :5173 (proxies /api)
```

Then in the UI, ingest the workbook
`sample-data-and-call-transcripts/02-investor-level-gl-to-loader/output/Tranche 1 - reference and verified loader v4c (anonymised).xlsx`
and ask about mapping rules, batch-type overrides, and mapping gaps.

## Deploy (GCP)

One-time: Artifact Registry repo `ylookup` in `europe-west2`, a GKE cluster
`ylookup-gke`, a Model Garden Qwen deployment, and IAM for the default compute
service account `394788628847-compute@developer.gserviceaccount.com`
(`roles/aiplatform.user` for the app, `roles/container.developer` +
`roles/artifactregistry.writer` for builds — see `cloudbuild.yaml` and
`deploy/k8s/app.yaml` comments). Then:

```sh
gcloud builds submit --project=priv-mkt-hack26lon-3752 \
  --service-account=projects/priv-mkt-hack26lon-3752/serviceAccounts/394788628847-compute@developer.gserviceaccount.com
```

This builds the app and engine images, pushes them to Artifact Registry pinned
to the commit SHA, applies `deploy/k8s/`, and waits for rollout.

See `AGENTS.md` for repo conventions.
