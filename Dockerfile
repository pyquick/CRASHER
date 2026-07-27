# ---- Build Stage ----
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# ---- Runtime Stage ----
FROM node:24-alpine

WORKDIR /app

# Install runtime dependencies (better-sqlite3 needs build tools)
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && apk del python3 make g++

COPY --from=builder /app/dist/ ./dist/
COPY web/ ./web/

# Create data directory
RUN mkdir -p /app/data/symbols /app/data/attachments

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data
ENV AUTH_TOKEN=

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "dist/main.js"]
