# YLookup — common dev/build/deploy commands
# Run `make help` to list targets.

SHELL := /bin/bash
PROJECT := priv-mkt-hack26lon-3752
BUILD_SA := projects/$(PROJECT)/serviceAccounts/394788628847-compute@developer.gserviceaccount.com

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---- Local dev ----

.PHONY: backend
backend: ## Start everything except the frontend in Docker (qdrant + engine + app, :8080)
	docker compose up --build qdrant engine app

.PHONY: backend-dev
backend-dev: ## Start the API server natively in dev mode (tsx watch, :8080)
	cd server && npm run dev

.PHONY: frontend
frontend: ## Start the web UI in dev mode (vite, :5173, proxies /api)
	cd web && npm run dev

.PHONY: engine
engine: ## Start the Python engine locally (:8081)
	cd engine && uvicorn app.main:app --reload --port 8081

.PHONY: services
services: ## Start backing services (qdrant, engine) via docker compose
	docker compose up -d qdrant engine

.PHONY: services-down
services-down: ## Stop backing services
	docker compose down

# ---- Setup / checks ----

.PHONY: install
install: ## Install server and web dependencies
	cd server && npm install
	cd web && npm install

.PHONY: test
test: ## Run server tests (vitest)
	cd server && npm test

.PHONY: check
check: ## Typecheck + tests + builds + engine compile (definition of done)
	cd server && npm test && npm run typecheck && npm run build
	cd web && npm run build
	python3 -m py_compile engine/app/main.py

.PHONY: build
build: ## Build server and web production bundles
	cd server && npm run build
	cd web && npm run build

# ---- Docker / deploy ----

.PHONY: docker-build
docker-build: ## Build app and engine images locally
	docker build -t ylookup-app .
	docker build -t ylookup-engine ./engine

.PHONY: deploy
deploy: ## Build + push + deploy to GKE via Cloud Build
	gcloud builds submit --project=$(PROJECT) --service-account=$(BUILD_SA) \
	  --substitutions=COMMIT_SHA=$(shell git rev-parse HEAD)
