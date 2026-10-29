#!/usr/bin/env bash
# Container entrypoint (single container, e.g. Koyeb). Starts:
#   1. runner.py as root on 127.0.0.1:8100. It runs student code, dropping each program to the
#      unprivileged `sandbox` user (SANDBOX_UID). It gets an empty environment plus its own settings,
#      so student programs can never read the API keys or Firebase credentials.
#   2. the app (run_production.sh) as `appuser`, talking to the runner via RUNNER_URL + RUNNER_TOKEN.
# If either process exits, the other is stopped and the container exits, so the platform restarts it.
set -euo pipefail
cd /app

# A command was given (docker-compose's separate `runner` service): run just that
if [ "$#" -gt 0 ]; then
    exec "$@"
fi
# docker-compose: the runner is its own container already
if [ -n "${RUNNER_URL:-}" ] && [ "$(id -u)" = 0 ]; then
    export HOME=/home/appuser
    exec setpriv --reuid=appuser --regid=appuser --init-groups ./run_production.sh
fi
# Not root (e.g. `docker run --user`): no runner; code runs inside the app under sandbox.py's limits
if [ "$(id -u)" != 0 ]; then
    echo "entrypoint: not root, starting the app without the separate code runner" >&2
    exec ./run_production.sh
fi

export RUNNER_TOKEN="${RUNNER_TOKEN:-$(python -c 'import secrets; print(secrets.token_hex(32))')}"

# Runner settings passed through: CODE_* limits and SANDBOX_* options (see sandbox.py)
runner_env=(PATH="$PATH" HOME=/root LANG=C.UTF-8 PYTHONUNBUFFERED=1
    RUNNER_TOKEN="$RUNNER_TOKEN" SANDBOX_UID=10001 SANDBOX_PKG_DIR=/var/lib/sandbox-pkgs
    SANDBOX_MPL_CACHE="${SANDBOX_MPL_CACHE:-/opt/mplcache}")
while IFS='=' read -r name value; do
    case "$name" in
        CODE_*|SANDBOX_*) [ "$name" = SANDBOX_UID ] || runner_env+=("$name=$value") ;;
    esac
done < <(env)

env -i "${runner_env[@]}" uvicorn runner:app --host 127.0.0.1 --port 8100 --log-level warning &
runner_pid=$!

export RUNNER_URL=http://127.0.0.1:8100
export HOME=/home/appuser
setpriv --reuid=appuser --regid=appuser --init-groups ./run_production.sh &
app_pid=$!

trap 'kill -TERM "$runner_pid" "$app_pid" 2>/dev/null || true' TERM INT
set +e
wait -n "$runner_pid" "$app_pid"
status=$?
echo "entrypoint: a process exited (status $status), stopping the container" >&2
kill -TERM "$runner_pid" "$app_pid" 2>/dev/null
wait
exit "$status"
