# ---------- Stage 1: build the React frontend ----------
FROM node:22-alpine AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- Stage 2: build the TypeScript server ----------
FROM node:22-alpine AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---------- Stage 3: runtime ----------
FROM node:22-alpine
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY --from=server-build /build/server/node_modules ./node_modules
COPY --from=server-build /build/server/dist ./dist
COPY --from=server-build /build/server/package.json ./package.json
COPY --from=web-build /build/web/dist ./public

# Runtime config is env-only (see .env.example): Vertex AI credentials come from
# the platform (Workload Identity on GKE / ADC locally), vectors live in Qdrant
# (QDRANT_URL), and the deterministic engine is a sibling service (ENGINE_URL).

EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
