#!/usr/bin/env bash
# Production-style server: multiple workers + long timeout (Koyeb / VPS).
# Set REDIS_URL for session sharing across workers.
set -euo pipefail
cd "$(dirname "$0")"
# Koyeb (and most platforms) set PORT; API_PORT overrides it
export API_PORT="${API_PORT:-${PORT:-8000}}"
export API_RELOAD=false
WORKERS="${WEB_CONCURRENCY:-4}"
exec gunicorn main:app \
  -k uvicorn.workers.UvicornWorker \
  -w "$WORKERS" \
  --bind "0.0.0.0:${API_PORT}" \
  --timeout 120 \
  --graceful-timeout 30 \
  --access-logfile - \
  --error-logfile -
