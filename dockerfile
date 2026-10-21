# CodeOracle — FastAPI + Monaco IDE (see README.md / DOCKER.md)
# Image: rahadarmannabid/codeoracle
# Secrets: pass at runtime (env_file / -e / orchestrator), not baked into layers.

FROM python:3.11-slim

LABEL org.opencontainers.image.title="CodeOracle"
LABEL org.opencontainers.image.description="AI-assisted coding study platform (FastAPI)"
LABEL org.opencontainers.image.source="https://hub.docker.com/r/rahadarmannabid/codeoracle"

WORKDIR /app

# Runtime deps (gcc/g++ for some wheels; JDK for optional Java execution; curl for healthcheck)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    default-jdk \
    curl \
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

# App source (.dockerignore excludes .env, submissions, logs, etc.)
COPY --chown=appuser:appuser . .

# Verify layout (no .env required — configure via container env at run time)
RUN echo "=== VERIFYING CRITICAL FILES ===" && \
    test -f /app/main.py && test -f /app/admin.py && test -f /app/runner.py && test -f /app/sandbox.py && \
    test -f /app/sandbox_shims/turtle.py && test -f /app/sandbox_shims/_sandbox_mpl.py && \
    test -f /app/run_production.sh && \
    test -d /app/templates && \
    test -f /app/templates/home.html && \
    test -f /app/templates/index.html && \
    test -f /app/templates/survey.html && \
    test -d /app/surveys && test -d /app/surveys/images && \
    echo "✅ Verification complete"

RUN mkdir -p submissions session_logs logs surveys/quiz_assets && \
    chmod +x /app/run_production.sh && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

# gunicorn + UvicornWorker (see run_production.sh). Set API_PORT / WEB_CONCURRENCY / REDIS_URL at runtime.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["./run_production.sh"]
