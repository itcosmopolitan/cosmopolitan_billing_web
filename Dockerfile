# ╔══════════════════════════════════════════════════════════════════╗
# ║  Cosmopolitan Pro — Production Dockerfile (Render)              ║
# ║  Multi-stage build:                                             ║
# ║    Stage 1 (builder) — Node 20 builds the Vite/React frontend  ║
# ║    Stage 2 (runtime) — Python 3.11 runs FastAPI + serves dist  ║
# ╚══════════════════════════════════════════════════════════════════╝

# ─── Stage 1: Build the React/Vite frontend ───────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /build/frontend

# Install dependencies first (layer-cached unless package.json changes)
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --prefer-offline

# Copy the rest of the frontend source and build
COPY frontend/ ./
RUN npm run build
# Output: /build/frontend/dist


# ─── Stage 2: Python runtime ──────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

# Install system deps needed by psycopg2-binary (libpq) and other C extensions
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libpq-dev \
        gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Python dependencies ───────────────────────────────────────────────────────
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# ── Backend source ────────────────────────────────────────────────────────────
COPY backend/ ./backend/

# ── Copy built frontend into the location FastAPI will serve ──────────────────
# FastAPI mounts /app/frontend/dist as /  (see main.py StaticFiles mount)
COPY --from=frontend-builder /build/frontend/dist ./frontend/dist

# ── Python path: `from src import ...` resolves inside /app/backend ───────────
ENV PYTHONPATH=/app/backend

# Render injects $PORT at runtime (default 10000 for local testing)
EXPOSE 10000

# ── Start: uvicorn with the correct module path ───────────────────────────────
# PYTHONPATH=/app/backend  →  `src.main` resolves to /app/backend/src/main.py
CMD ["sh", "-c", "uvicorn src.main:app --host 0.0.0.0 --port ${PORT:-10000}"]
