# ═══════════════════════════════════════════════════════════════
# EduVid AI — Multi-stage Dockerfile
# Stage 1: Build TypeScript
# Stage 2: Production runtime with FFmpeg
# ═══════════════════════════════════════════════════════════════

# ── Build Stage ─────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (canvas)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    pkg-config \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY src/ ./src/

# Build TypeScript server + Vite client
RUN npx tsc
RUN npx vite build

# ── Production Stage ────────────────────────────────────────────
FROM node:20-slim AS production

WORKDIR /app

# Install runtime dependencies: FFmpeg + canvas native libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libcairo2 \
    libjpeg62-turbo \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgif7 \
    librsvg2-2 \
  && rm -rf /var/lib/apt/lists/*

# Copy production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled server + built client
COPY --from=builder /app/dist ./dist

# Create required directories
RUN mkdir -p output tmp data

# Runtime configuration
ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
