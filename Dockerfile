# Mental Models of AI — FastAPI + Monaco IDE, one container for Koyeb (see DOCKER.md)
# Image: rahadarmannabid/mental-model-of-ai   Build + push: ./build-and-push.sh
# Secrets (OpenAI, Firebase, Redis, SMTP): set as environment variables at run time, never baked in.
#
# Two processes run inside (docker-entrypoint.sh):
#   runner.py  root, 127.0.0.1:8100   runs student code; each program as the unprivileged `sandbox` user
#   the app    appuser, $PORT         gunicorn + UvicornWorker (run_production.sh)
# The runner starts with an empty environment, so student programs never see the app's secrets.

FROM python:3.11-slim

LABEL org.opencontainers.image.title="Mental Models of AI"
LABEL org.opencontainers.image.description="AI-assisted coding study platform (FastAPI)"
LABEL org.opencontainers.image.source="https://hub.docker.com/r/rahadarmannabid/mental-model-of-ai"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# gcc/g++ and the JDK run students' C, C++ and Java; curl for the health check; tini as PID 1
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    default-jdk-headless \
    curl \
    tini \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 appuser && \
    useradd -r -u 10001 -M -s /usr/sbin/nologin sandbox   # runs student programs (runner.py)

COPY requirements.txt requirements-sandbox.txt ./
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt -r requirements-sandbox.txt

# Matplotlib font cache built once here, copied into each run (sandbox.py: SANDBOX_MPL_CACHE)
ENV SANDBOX_MPL_CACHE=/opt/mplcache
RUN MPLCONFIGDIR=/opt/mplcache MPLBACKEND=Agg python -c "import matplotlib.pyplot" && chmod -R a+rX /opt/mplcache

# App source (.dockerignore excludes .env, Firebase key files, logs, submissions, etc.)
COPY --chown=appuser:appuser . .

RUN test -f main.py && test -f runner.py && test -f sandbox.py && test -f run_production.sh && \
    test -f docker-entrypoint.sh && test -f sandbox_shims/turtle.py && test -f static/voice_input.js && \
    test -f templates/index.html && test -f templates/survey.html && \
    test -f surveys/default_autocomplete_tasks.json && test -f surveys/default_agent_tasks.json && \
    ! test -e .env && ! ls ./*firebase-adminsdk*.json >/dev/null 2>&1 && \
    echo "✅ files OK, no secrets in the image"

RUN mkdir -p submissions session_logs logs surveys/quiz_assets /var/lib/sandbox-pkgs && \
    chmod +x run_production.sh docker-entrypoint.sh && \
    chown -R appuser:appuser /app && \
    chmod 755 /var/lib/sandbox-pkgs

# Koyeb sets PORT; WEB_CONCURRENCY = gunicorn workers (default 4, about 2 GB RAM in total)
ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8000}/health" || exit 1

# Starts as root only to launch the runner; the app itself runs as appuser
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
