#!/usr/bin/env bash
# Build the production image and push it to Docker Hub, for Koyeb.
# Run from the repo root:
#   ./build-and-push.sh              build linux/amd64 (Koyeb), push :<version> and :latest
#   ./build-and-push.sh v1.2.0       same, with your own version tag
#   ./build-and-push.sh local        build for this machine only and smoke-test it (no push)
#
# Environment:
#   DOCKER_REPO              image name (default rahadarmannabid/mental-model-of-ai)
#   DOCKER_PLATFORMS         default linux/amd64 (what Koyeb runs); e.g. linux/amd64,linux/arm64
#   DOCKER_BUILD_NO_CACHE=1  rebuild every layer
set -euo pipefail
cd "$(dirname "$0")"

DOCKER_REPO="${DOCKER_REPO:-rahadarmannabid/mental-model-of-ai}"
DOCKER_PLATFORMS="${DOCKER_PLATFORMS:-linux/amd64}"
BUILDER_NAME="${BUILDX_BUILDER:-mental-model-builder}"
NO_CACHE=()
[ "${DOCKER_BUILD_NO_CACHE:-0}" = "1" ] && NO_CACHE=(--no-cache)

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx \033[0m %s\n' "$*" >&2; exit 1; }

case "${1:-}" in -h|--help) sed -n '2,13p' "$0"; exit 0 ;; esac

command -v docker >/dev/null || die "docker not found. Install Docker Desktop."
docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop and try again."
[ -f Dockerfile ] || die "Dockerfile not found (run from the repo root)."
# The image must never contain secrets (.dockerignore excludes them; the Dockerfile checks too)
grep -qx '.env' .dockerignore || die ".dockerignore must exclude .env"

# ─── Local build + smoke test (no push) ─────────────────────────────────────
if [ "${1:-}" = "local" ]; then
    TAG="${DOCKER_REPO}:local"
    info "Building $TAG for this machine"
    docker build "${NO_CACHE[@]+"${NO_CACHE[@]}"}" -t "$TAG" .

    info "Smoke test: starting the container on port 18000"
    name="mental-model-smoke-$$"
    env_args=()
    [ -f .env ] && env_args=(--env-file .env)
    docker run -d --name "$name" -p 18000:8000 "${env_args[@]+"${env_args[@]}"}" -e API_PORT=8000 -e PORT=8000 "$TAG" >/dev/null
    trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
    for _ in $(seq 1 60); do
        curl -fsS http://127.0.0.1:18000/health >/dev/null 2>&1 && break
        sleep 2
    done
    if curl -fsS http://127.0.0.1:18000/health >/dev/null 2>&1; then
        info "Health check OK: $(curl -fsS http://127.0.0.1:18000/health)"
        info "Image works. To push for Koyeb: ./build-and-push.sh"
    else
        docker logs "$name" 2>&1 | tail -40
        die "The container did not become healthy (logs above)."
    fi
    exit 0
fi

# ─── Build for Koyeb + push to Docker Hub ───────────────────────────────────
VERSION="${1:-v$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo nogit)}"

if ! grep -q 'index.docker.io' "$HOME/.docker/config.json" 2>/dev/null; then
    info "Log in to Docker Hub (account rahadarmannabid)"
    docker login
fi

docker buildx version >/dev/null 2>&1 || die "docker buildx not found (it comes with Docker Desktop)."
if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    info "Creating buildx builder $BUILDER_NAME"
    docker buildx create --name "$BUILDER_NAME" --driver docker-container --bootstrap >/dev/null
fi

info "Building $DOCKER_REPO:$VERSION for $DOCKER_PLATFORMS and pushing (also :latest)"
docker buildx build --builder "$BUILDER_NAME" "${NO_CACHE[@]+"${NO_CACHE[@]}"}" \
    --platform "$DOCKER_PLATFORMS" \
    -t "$DOCKER_REPO:$VERSION" \
    -t "$DOCKER_REPO:latest" \
    --push \
    .

cat <<EOF

✅ Pushed $DOCKER_REPO:$VERSION and :latest ($DOCKER_PLATFORMS)

Koyeb (first time): Create Service → Docker image → $DOCKER_REPO:latest
  - Exposed port 8000 (HTTP, route /); health check: HTTP GET /health on port 8000
  - Instance with at least 2 GB RAM (4 workers + code runner), or set WEB_CONCURRENCY=2 on 1 GB
  - Environment variables: copy them from your .env (secrets as Koyeb Secrets), see DOCKER.md
Koyeb (update): Service → Redeploy (it pulls :latest again), or deploy the tag $VERSION.
EOF
