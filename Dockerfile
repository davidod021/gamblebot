# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

# Build tools needed for native modules (e.g. sqlite3 via @google/adk)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app

# Copy compiled output and production node_modules (includes native binaries)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# All config comes from environment variables — no .env file baked in
ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
