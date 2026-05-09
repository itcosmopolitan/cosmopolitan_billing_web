# Use Python base image
FROM python:3.11

# Install Node (only for building frontend)
RUN apt-get update && apt-get install -y nodejs npm

# Set working directory
WORKDIR /app

# Copy entire project
COPY . .

# ─── Install backend dependencies ─────────────────────
RUN pip install --upgrade pip
RUN pip install -r backend/requirements.txt

# ─── Build frontend (production build) ────────────────
WORKDIR /app/frontend
RUN npm install
RUN yarn build

# ─── Back to root ─────────────────────────────────────
WORKDIR /app

# Fix Python import path (so `src` works)
ENV PYTHONPATH=/app/backend

# Expose port (Render uses dynamic port internally)
EXPOSE 10000

# ─── Start FastAPI (ONLY one service) ─────────────────
CMD ["sh", "-c", "uvicorn backend.src.main:app --host 0.0.0.0 --port $PORT"]
