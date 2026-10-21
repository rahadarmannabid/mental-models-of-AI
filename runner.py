"""Code runner service: executes student code in its own container, away from the main app.

Run it with no application secrets in its environment and no internet access (see
docker-compose.yml). The main app reaches it with RUNNER_URL + RUNNER_TOKEN.

    uvicorn runner:app --host 0.0.0.0 --port 8100     # one process; concurrency is async

Protocol (WebSocket /run):
    client → {"type": "start", "key", "language", "files", "entry"}
             or {"type": "start", "key", "action": "pip", "args": ["install", "requests"], "files"}
    client → {"type": "stdin", "data": "line\\n"} | {"type": "eof"} | {"type": "stop"}
    runner → {"type": "status", "phase"} | {"type": "output", "stream", "data"}
             | {"type": "display", "mime", "name", "data" (base64)}
             | {"type": "exit", ...result} | {"type": "rejected", "message"}

POST /packages/clear {"key"} deletes a session's installed packages (the app calls it on submit).
"""

import asyncio
import hmac
import logging
import os
from typing import Dict, List, Optional

from fastapi import FastAPI, Header, HTTPException, WebSocket
from pydantic import BaseModel

import sandbox

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("runner")

RUNNER_TOKEN = os.getenv("RUNNER_TOKEN", "")
if not RUNNER_TOKEN:
    raise SystemExit("RUNNER_TOKEN must be set")

app = FastAPI(title="Code runner", docs_url=None, redoc_url=None, openapi_url=None)


def _authorized(token: Optional[str]) -> bool:
    return bool(token) and hmac.compare_digest(token, RUNNER_TOKEN)


@app.get("/health")
async def health():
    return {"status": "ok", "limits": sandbox.LIMITS, "stats": sandbox.stats,
            "sandbox_uid": sandbox.SANDBOX_UID if os.geteuid() == 0 else None}


class BatchRequest(BaseModel):
    key: str
    language: str
    files: List[Dict[str, str]]
    entry: Optional[str] = None
    stdin: Optional[str] = None


@app.post("/execute")
async def execute(req: BatchRequest, x_runner_token: Optional[str] = Header(default=None)):
    if not _authorized(x_runner_token):
        raise HTTPException(status_code=403)
    return await sandbox.run_batch(key=req.key, language=req.language, files=req.files, entry=req.entry, stdin=req.stdin)


class ClearPackagesRequest(BaseModel):
    key: str


@app.post("/packages/clear")
async def clear_packages(req: ClearPackagesRequest, x_runner_token: Optional[str] = Header(default=None)):
    if not _authorized(x_runner_token):
        raise HTTPException(status_code=403)
    return {"removed": await asyncio.to_thread(sandbox.clear_packages, req.key)}


@app.websocket("/run")
async def run_ws(ws: WebSocket):
    if not _authorized(ws.headers.get("x-runner-token")):
        await ws.close(code=4403)
        return
    await ws.accept()
    await sandbox.serve_websocket(ws)
