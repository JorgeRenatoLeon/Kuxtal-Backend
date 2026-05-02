# ─── Build stage ────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# OpenSSL is required by Prisma's query engine on Alpine
RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate
RUN npx tsc
# Copy non-TS runtime assets (admin dashboard HTML) into dist
RUN mkdir -p dist/admin && cp src/admin/admin.html dist/admin/admin.html

# ─── Production stage ──────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

RUN apk add --no-cache openssl wget

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

COPY --from=build /app/dist ./dist

EXPOSE 8000

# Sync schema then start. `db push` is idempotent and safe to re-run.
# DATABASE_URL, JWT_SECRET, CORS_ORIGINS etc. are read from environment.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss=false && node dist/index.js"]
