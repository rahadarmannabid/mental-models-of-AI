# Docker image `rahadarmannabid/mental-model-of-ai` (Koyeb)

The image contains no secrets: no `.env`, no Firebase key file (the Dockerfile fails the build if
one slips in). All configuration is set as environment variables where the container runs.

## Build and push

```bash
docker login                      # once, Docker Hub account rahadarmannabid
./build-and-push.sh local         # optional: build for this Mac and check /health (no push)
./build-and-push.sh               # build linux/amd64 for Koyeb, push :v<date>-<commit> and :latest
./build-and-push.sh v1.0.0        # or choose the version tag
```

Koyeb runs `linux/amd64`. On an Apple Silicon Mac that build is emulated, so it is slower (the first
one takes a while; later ones reuse cached layers). `DOCKER_PLATFORMS=linux/amd64,linux/arm64` builds both.

## What runs in the container

`docker-entrypoint.sh` starts two processes:

| Process | User | Address | Job |
|---|---|---|---|
| `runner.py` | root, each student program as `sandbox` (uid 10001) | 127.0.0.1:8100 (inside only) | runs student code and `pip install` |
| the app (`run_production.sh`, gunicorn) | `appuser` | `$PORT` (8000) | the website and API |

The runner starts with an empty environment, so student programs cannot see the OpenAI key or the
Firebase credentials. `RUNNER_TOKEN` is generated at start if you do not set it. If either process
dies, the container exits and Koyeb restarts it.

## Koyeb setup (first time)

1. **Create Service → Docker image:** `docker.io/rahadarmannabid/mental-model-of-ai:latest`
   (for a private Docker Hub repo, add a registry secret with your Docker Hub token).
2. **Instance:** at least 2 GB RAM (4 app workers + code runner). On 1 GB set `WEB_CONCURRENCY=2`.
   Use one instance: if you scale out, `REDIS_URL` is required (it is anyway, see below).
3. **Ports:** 8000, protocol HTTP, route `/`.
4. **Health check:** HTTP, port 8000, path `/health`, grace period 60 s.
5. **Environment variables** (mark keys as Koyeb Secrets):

| Variable | Notes |
|---|---|
| `OPENAI_API_KEY` | secret |
| `SESSION_SECRET_KEY` | secret; keep it stable or everyone is logged out on each deploy |
| `REDIS_URL` | secret; Upstash `rediss://...` URL (sessions shared by the workers) |
| `FIREBASE_PROJECT_ID`, `FIREBASE_DATABASE_URL`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_CLIENT_ID`, `FIREBASE_CLIENT_CERT_URL`, `FIREBASE_PRIVATE_KEY_ID` | from the service account |
| `FIREBASE_PRIVATE_KEY` | secret; paste with `\n` for line breaks, as in `.env` |
| `EMAIL_ENABLED`, `SMTP_SERVER`, `SMTP_PORT`, `EMAIL_ADDRESS`, `EMAIL_PASSWORD`, `NOTIFICATION_EMAIL` | instructor OTP emails; password as secret |
| `OTP_DEV_MODE` | must be `false` |
| `CORS_ORIGINS` | your Koyeb URL, e.g. `https://<app>.koyeb.app` |
| optional | `TEACHER_ACCESS_CODE`, `COMPLETION_MODEL`, `AGENT_MODEL`, `INSTRUCTOR_LOGIN_HOURS`, `WEB_CONCURRENCY`, `CODE_MAX_CONCURRENT`, `CODE_MEMORY_MB` |

Do not set `RUNNER_URL`, `API_RELOAD` or `PORT` (Koyeb sets `PORT`).

**Update:** run `./build-and-push.sh`, then **Redeploy** the service in Koyeb (it pulls `:latest`).

## Things that do not survive a redeploy

The container's disk is temporary. Study data goes to Firebase, but these local folders are lost on
each deploy or restart: `submissions/`, `session_logs/`, `logs/`, packages students `pip install`ed,
and **survey images instructors upload** (`surveys/quiz_assets/`). Re-upload those images after a
redeploy, or attach a Koyeb volume at `/app/surveys/quiz_assets`.

## Other ways to run it

```bash
# one container, like Koyeb
docker run -d -p 8000:8000 --env-file .env rahadarmannabid/mental-model-of-ai:latest

# docker compose: app + separate runner container on an internal network (no internet) + Redis
echo "RUNNER_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose up -d
```

Sizing: keep `CODE_MAX_CONCURRENT × CODE_MEMORY_MB` within the container's memory. In the single
container, compiled C/C++/Java programs are contained by the `sandbox` user and the resource limits,
but unlike the compose setup they can reach the internet (Python programs are blocked by the audit hook).
