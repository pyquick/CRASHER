# Docker Hub may be inaccessible on some networks. Override at build time if needed:
# docker build --build-arg NODE_IMAGE=node:24-alpine .
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-alpine

# ---- Build Stage ----
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# better-sqlite3 compiles through node-gyp on Alpine.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
# TypeScript and its type definitions are development dependencies.
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ---- Runtime Stage ----
FROM ${NODE_IMAGE}

WORKDIR /app

# Build the better-sqlite3 native module, then remove the toolchain.
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
