#!/bin/sh

set -e

echo "Starting Cosmopolitan Pro Production..."

cd /app/backend

exec gunicorn -k uvicorn.workers.UvicornWorker src.main:app \
  --workers 2 \
  --threads 4 \
  --bind 0.0.0.0:$PORT \
  --timeout 120
