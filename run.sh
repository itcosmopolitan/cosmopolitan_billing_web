#!/bin/sh

set -e

echo "Starting Cosmopolitan Pro..."

cd /app/backend

exec uvicorn src.main:app --host 0.0.0.0 --port 10000