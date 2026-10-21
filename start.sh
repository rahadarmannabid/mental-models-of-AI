#!/usr/bin/env bash
# One-command launcher: sets up the venv, installs dependencies, prepares .env,
# makes sure Redis is available, then starts the production server.
#
# Usage:  ./start.sh            (production: gunicorn, multiple workers)
#         ./start.sh --dev      (single uvicorn process with auto-reload)
set -euo pipefail
cd "$(dirname "$0")"

MODE="prod"
[[ "${1:-}" == "--dev" ]] && MODE="dev"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!! \033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Python virtual environment + dependencies
# ---------------------------------------------------------------------------
PYTHON_BIN="${PYTHON_BIN:-python3}"
command -v "$PYTHON_BIN" >/dev/null || die "python3 not found. Install Python 3.10+ first."

# The venv lives outside the project on purpose: when the project sits in an
# iCloud-synced folder (e.g. ~/Documents), every file read inside it is slow and
# importing the app from a local .venv can take minutes. Override with VENV_DIR.
VENV_DIR="${VENV_DIR:-$HOME/.venvs/codeoracle}"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  info "Creating virtual environment in $VENV_DIR"
  mkdir -p "$(dirname "$VENV_DIR")"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
# Keep bytecode caches out of the (possibly synced) project folder too.
export PYTHONPYCACHEPREFIX="${PYTHONPYCACHEPREFIX:-$HOME/.cache/codeoracle-pycache}"

# Reinstall only when a requirements file changed since the last successful install.
# requirements-sandbox.txt: packages student programs can import (numpy, pandas, matplotlib).
REQ_HASH="$(cat requirements.txt requirements-sandbox.txt | shasum | awk '{print $1}')"
if [[ "$(cat "$VENV_DIR/.requirements.sha" 2>/dev/null || true)" != "$REQ_HASH" ]]; then
  info "Installing dependencies"
  python -m pip install --upgrade pip -q
  python -m pip install -r requirements.txt -r requirements-sandbox.txt
  echo "$REQ_HASH" > "$VENV_DIR/.requirements.sha"
else
  info "Dependencies up to date"
fi

# ---------------------------------------------------------------------------
# 2. .env file (created on first run)
# ---------------------------------------------------------------------------
if [[ ! -f .env ]]; then
  info "No .env found, creating one"
  key="${OPENAI_API_KEY:-}"
  if [[ -z "$key" ]]; then
    read -r -s -p "Enter your OpenAI API key (sk-...): " key; echo
  fi
  [[ -n "$key" ]] || die "An OpenAI API key is required."
  secret="$(python -c 'import secrets; print(secrets.token_hex(32))')"
  cat > .env <<EOF
OPENAI_API_KEY=$key
APP_TITLE=AI Code Assistant API
API_HOST=0.0.0.0
API_PORT=8000
LOG_LEVEL=info
SESSION_SECRET_KEY=$secret
EOF
  chmod 600 .env
  info ".env created (add Firebase / study-condition settings there if needed)"
fi

# Read values from .env without overriding anything already exported.
env_get() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }
grep -qE '^OPENAI_API_KEY=.+' .env || die "OPENAI_API_KEY is missing in .env"
export API_PORT="${API_PORT:-$(env_get API_PORT)}"
export API_PORT="${API_PORT:-8000}"
export REDIS_URL="${REDIS_URL:-$(env_get REDIS_URL)}"

mkdir -p submissions session_logs logs

# ---------------------------------------------------------------------------
# Port: stop a leftover server from this project, otherwise move to a free port
# ---------------------------------------------------------------------------
port_pids() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }
pid_cwd()   { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; }

first_port="$API_PORT"
while pids="$(port_pids "$API_PORT")"; [[ -n "$pids" ]]; do
  ours=1
  for pid in $pids; do [[ "$(pid_cwd "$pid")" == "$PWD" ]] || ours=0; done
  if [[ "$ours" == 1 ]]; then
    info "Stopping previous server of this project on port $API_PORT"
    kill $pids 2>/dev/null || true
    for _ in {1..20}; do [[ -z "$(port_pids "$API_PORT")" ]] && break; sleep 0.25; done
    [[ -z "$(port_pids "$API_PORT")" ]] || kill -9 $(port_pids "$API_PORT") 2>/dev/null || true
    break
  fi
  API_PORT=$((API_PORT + 1))
done
[[ "$API_PORT" == "$first_port" ]] || warn "Port $first_port is used by another program, using port $API_PORT instead"
export API_PORT

# ---------------------------------------------------------------------------
# 3. Dev mode: single process, no Redis needed
# ---------------------------------------------------------------------------
if [[ "$MODE" == "dev" ]]; then
  info "Starting dev server on http://localhost:${API_PORT}"
  # uvicorn directly (not `python main.py`): main.py reloads .env with override,
  # which would undo a port change made above.
  exec python -m uvicorn main:app --host 0.0.0.0 --port "$API_PORT" --reload
fi

# ---------------------------------------------------------------------------
# 4. Redis: multiple workers need it to share session state
# ---------------------------------------------------------------------------
redis_up() { python - "$1" <<'PY' 2>/dev/null
import sys, redis
redis.Redis.from_url(sys.argv[1], socket_connect_timeout=2).ping()
PY
}

LOCAL_REDIS_URL="redis://localhost:6379/0"
if [[ -z "$REDIS_URL" ]]; then
  if redis_up "$LOCAL_REDIS_URL"; then
    info "Using Redis already running on localhost:6379"
  elif command -v redis-server >/dev/null; then
    info "Starting local redis-server"
    redis-server --daemonize yes --port 6379 --dir "$PWD/logs" --logfile "$PWD/logs/redis.log" >/dev/null
  elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    info "Starting Redis in Docker (container: codeoracle_redis_local)"
    docker start codeoracle_redis_local >/dev/null 2>&1 \
      || docker run -d --name codeoracle_redis_local -p 6379:6379 redis:7-alpine >/dev/null
  elif command -v brew >/dev/null; then
    info "Installing Redis with Homebrew"
    brew install redis >/dev/null
    redis-server --daemonize yes --port 6379 --dir "$PWD/logs" --logfile "$PWD/logs/redis.log" >/dev/null
  fi
  for _ in {1..10}; do redis_up "$LOCAL_REDIS_URL" && break; sleep 1; done
  if redis_up "$LOCAL_REDIS_URL"; then
    export REDIS_URL="$LOCAL_REDIS_URL"
  fi
fi

if [[ -n "$REDIS_URL" ]] && redis_up "$REDIS_URL"; then
  WORKERS="${WEB_CONCURRENCY:-4}"
  info "Redis OK, running ${WORKERS} workers"
else
  warn "Redis unavailable: falling back to 1 worker (in-memory sessions are not shared across workers)"
  unset REDIS_URL
  WORKERS=1
fi

# ---------------------------------------------------------------------------
# 5. Launch
# ---------------------------------------------------------------------------
export API_RELOAD=false
# macOS: forked gunicorn workers otherwise abort in the Objective-C runtime when one is restarted.
[[ "$(uname)" == "Darwin" ]] && export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES
info "Starting server on http://localhost:${API_PORT}  (Ctrl+C to stop)"
exec python -m gunicorn main:app \
  -k uvicorn.workers.UvicornWorker \
  -w "$WORKERS" \
  --bind "0.0.0.0:${API_PORT}" \
  --timeout 120 \
  --graceful-timeout 30 \
  --access-logfile - \
  --error-logfile -
