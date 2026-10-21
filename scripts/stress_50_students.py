#!/usr/bin/env python3
"""
Stress test: N simulated students (default 50) work through a quiz at the same time.

Each student:
  1. GET /quiz/{code} and POST /quiz/join
  2. GET /survey-config/{key} and submit the pre survey
  3. types code (POST /checkpoint-editor a few times)
  4. runs a Python program with stdin over the /ws/run terminal
  5. `pip install <small package>` in the terminal, then runs code that imports it
  6. submits the post survey

User IDs start with "stresstest_" so the records can be found and removed afterwards.

  python scripts/stress_50_students.py --access-code 2xGRMXwK -n 50
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import statistics
import time
import uuid
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from websockets.asyncio.client import connect as ws_connect

_SURVEY_DIR = Path(__file__).resolve().parent.parent / "surveys"
DEFAULT_SURVEYS = {k: json.loads((_SURVEY_DIR / f"instructor_default_{k}_survey.json").read_text())
                   for k in ("pre", "post")}

# Small pure-Python wheels only.
SMALL_PACKAGES = {
    "six": "import six; print('six', six.__version__)",
    "termcolor": "from termcolor import colored; print(colored('termcolor ok', 'green'))",
    "tabulate": "from tabulate import tabulate; print(tabulate([[1, 2]], headers=['a', 'b']))",
    "colorama": "import colorama; print('colorama', colorama.__version__)",
    "humanize": "import humanize; print(humanize.intcomma(1234567))",
    "emoji": "import emoji; print(emoji.emojize('ok :thumbs_up:'))",
    "inflect": "import inflect; print(inflect.engine().plural('student'))",
    "pyfiglet": "import pyfiglet; print(pyfiglet.figlet_format('hi')[:20])",
}

STUDENT_PROGRAM = """\
name = input("Name: ")
nums = [int(x) for x in input("Numbers: ").split()]
total = 0
for i in range(200000):
    total += i % 7
print(f"Hello {name}, sum={sum(nums)}, max={max(nums)}, work={total}")
"""


def answer_for(q: Dict[str, Any]) -> Any:
    t = (q.get("type") or "").strip()
    if t == "likert":
        sc = q.get("scale") or {}
        return random.randint(int(sc.get("min", 1)), int(sc.get("max", 5)))
    if t == "multiple_choice":
        return random.choice(q.get("options") or ["ok"])
    if t == "checkboxes":
        opts = q.get("options") or ["ok"]
        return random.sample(opts, random.randint(1, len(opts)))
    if t == "matrix":
        return {row: random.choice(q.get("columns") or ["ok"]) for row in q.get("rows") or []}
    if t == "slider":
        sc = q.get("scale") or {}
        return random.randint(int(sc.get("min", 0)), int(sc.get("max", 100)))
    if t == "open_ended":
        need = max(int(q.get("min_length") or 0), 20)
        return ("Stress test answer about coding with AI. " * 10)[:need + 10]
    return "ok"


def survey_payload(block: Dict[str, Any], kind: str, user_id: str, session_id: str, key: str) -> Dict[str, Any]:
    qs = [q for q in block.get("questions") or [] if isinstance(q, dict) and q.get("type") != "info_block"]
    cfg_keys = ("scale", "options", "rows", "columns", "placeholder", "max_length", "min_length")
    return {
        "user_id": user_id,
        "session_id": session_id,
        "assignment_key": key,
        "survey_type": kind,
        "survey_title": block.get("title") or kind,
        "survey_description": block.get("description") or "",
        "questions": [{"id": q.get("id"), "type": q.get("type"), "question": q.get("question") or "",
                       "required": q.get("required", True) is not False, **{k: q.get(k) for k in cfg_keys}}
                      for q in qs],
        "responses": [{"question_id": q.get("id"), "question_text": q.get("question") or "",
                       "question_type": q.get("type"), "question_config": {k: q.get(k) for k in cfg_keys},
                       "answer": answer_for(q), "required": q.get("required", True) is not False}
                      for q in qs],
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
        "total_questions": len(qs),
        "required_questions": sum(1 for q in qs if q.get("required", True) is not False),
        "completion_time_seconds": round(random.uniform(30, 120), 1),
    }


class Stats:
    def __init__(self) -> None:
        self.lat: Dict[str, List[float]] = defaultdict(list)
        self.errors: Dict[str, List[str]] = defaultdict(list)
        self.ok: Counter = Counter()
        self.skipped: Counter = Counter()
        self.retries: Counter = Counter()

    def record(self, step: str, ms: float, err: Optional[str] = None) -> None:
        self.lat[step].append(ms)
        if err:
            self.errors[step].append(err)
        else:
            self.ok[step] += 1


async def ws_session(base: str, start: Dict[str, Any], stdin: List[str], timeout: float) -> Dict[str, Any]:
    """Run one terminal command over /ws/run. Returns {exit, output, rejected, queued_ms}."""
    url = base.replace("http", "ws", 1) + "/ws/run"
    out: List[str] = []
    result: Dict[str, Any] = {"exit": None, "rejected": None, "displays": []}
    async with ws_connect(url, open_timeout=30, max_size=2 ** 22) as ws:
        await ws.send(json.dumps(start))
        sent_stdin = False

        async def reader() -> None:
            nonlocal sent_stdin
            async for raw in ws:
                msg = json.loads(raw)
                t = msg.get("type")
                if t == "output":
                    out.append(msg.get("data", ""))
                elif t == "display":
                    result["displays"].append({"mime": msg.get("mime"), "name": msg.get("name")})
                elif t == "status" and msg.get("phase") == "running" and stdin and not sent_stdin:
                    sent_stdin = True
                    for line in stdin:
                        await ws.send(json.dumps({"type": "stdin", "data": line}))
                elif t == "exit":
                    result["exit"] = msg
                    return
                elif t == "rejected":
                    result["rejected"] = msg.get("message")
                    return

        await asyncio.wait_for(reader(), timeout=timeout)
    result["output"] = "".join(out)
    return result


async def student(idx: int, args: argparse.Namespace, client: httpx.AsyncClient, st: Stats,
                  survey_cache: Dict[str, Any], gate: asyncio.Event) -> None:
    base = args.base_url
    user_id = f"stresstest_{idx:02d}_{uuid.uuid4().hex[:6]}"
    await gate.wait()
    await asyncio.sleep(random.uniform(0, args.ramp))  # students don't all click at the same millisecond

    async def timed(step: str, make):
        t = time.perf_counter()
        try:
            try:
                r = await make()
            except httpx.RemoteProtocolError:
                # Server closed an idle keep-alive connection as we reused it; browsers retry this silently.
                st.retries[step] += 1
                r = await make()
            return r, (time.perf_counter() - t) * 1000
        except Exception as e:
            st.record(step, (time.perf_counter() - t) * 1000, f"{type(e).__name__}: {e}"[:200])
            raise

    try:
        # 1. Join
        r, ms = await timed("page_load", lambda: client.get(f"{base}/quiz/{args.access_code}"))
        st.record("page_load", ms, None if r.status_code == 200 else f"HTTP {r.status_code}")
        r, ms = await timed("quiz_join", lambda: client.post(f"{base}/quiz/join", json={
            "access_code": args.access_code, "user_id": user_id, "programming_language": "python"}))
        data = r.json() if r.status_code == 200 else {}
        if data.get("status") != "success":
            st.record("quiz_join", ms, f"HTTP {r.status_code}: {r.text[:150]}")
            return
        st.record("quiz_join", ms)
        sid, quiz_id = data["session_id"], data["quiz_id"]
        key = f"quiz_{str(quiz_id)[:8].lower()}"

        # 2. Pre survey
        r, ms = await timed("survey_config", lambda: client.get(f"{base}/survey-config/{key}", params={"problem_index": 0}))
        st.record("survey_config", ms, None if r.status_code == 200 else f"HTTP {r.status_code}: {r.text[:150]}")
        cfg = r.json() if r.status_code == 200 else {}
        survey_cache.setdefault("cfg", cfg)
        pre, post = cfg.get("pre_survey") or {}, cfg.get("post_survey") or {}
        # Quiz without its own surveys: send the default instructor surveys so the endpoint is still exercised.
        if not pre.get("questions"):
            pre = {"title": "Pre-Study Survey", "questions": DEFAULT_SURVEYS["pre"]}
        if not post.get("questions"):
            post = {"title": "Post-Study Survey", "questions": DEFAULT_SURVEYS["post"]}

        async def submit_survey(kind: str, block: Dict[str, Any]) -> None:
            step = f"{kind}_survey"
            if not block.get("questions"):
                st.skipped[step] += 1
                return
            r, ms = await timed(step, lambda: client.post(f"{base}/submit-pre-post-survey",
                                                  json=survey_payload(block, kind, user_id, sid, key)))
            ok = r.status_code == 200 and r.json().get("status") == "success"
            st.record(step, ms, None if ok else f"HTTP {r.status_code}: {r.text[:150]}")

        await submit_survey("pre", pre)

        # 3. Typing: periodic editor checkpoints
        code_so_far = ""
        for line in STUDENT_PROGRAM.splitlines(keepends=True)[: args.checkpoints]:
            code_so_far += line
            await asyncio.sleep(random.uniform(0.2, 1.0))
            r, ms = await timed("checkpoint", lambda: client.post(f"{base}/checkpoint-editor", json={
                "session_id": sid, "user_id": user_id, "assignment_key": key, "code": code_so_far,
                "programming_language": "python", "current_problem_index": 0}))
            st.record("checkpoint", ms, None if r.status_code == 200 else f"HTTP {r.status_code}: {r.text[:150]}")

        # 4. Run a program with input
        files = [{"filename": "main.py", "content": STUDENT_PROGRAM}]
        res, ms = await timed("run_code", lambda: ws_session(base, {
            "session_id": sid, "language": "python", "files": files, "entry": "main.py"},
            [f"Student{idx}\n", "3 9 4 1\n"], args.run_timeout))
        ok = res["exit"] and res["exit"].get("exit_code") == 0 and f"Hello Student{idx}" in res["output"]
        st.record("run_code", ms, None if ok else
                  f"rejected={res['rejected']!r} exit={res['exit']} out={res['output'][-120:]!r}")

        # 5. pip install a small package, then import it
        if not args.no_pip:
            pkg = list(SMALL_PACKAGES)[idx % len(SMALL_PACKAGES)]
            res, ms = await timed("pip_install", lambda: ws_session(base, {
                "session_id": sid, "language": "python", "files": files, "action": "pip",
                "args": ["install", pkg]}, [], args.pip_timeout))
            ok = res["exit"] and res["exit"].get("exit_code") == 0
            st.record("pip_install", ms, None if ok else
                      f"{pkg}: rejected={res['rejected']!r} out={res['output'][-200:]!r}")
            if ok:
                files2 = [{"filename": "main.py", "content": SMALL_PACKAGES[pkg]}]
                res, ms = await timed("run_with_pkg", lambda: ws_session(base, {
                    "session_id": sid, "language": "python", "files": files2, "entry": "main.py"},
                    [], args.run_timeout))
                ok = res["exit"] and res["exit"].get("exit_code") == 0
                st.record("run_with_pkg", ms, None if ok else
                          f"{pkg}: rejected={res['rejected']!r} out={res['output'][-200:]!r}")

        # 6. Post survey
        await submit_survey("post", post)
    except Exception:
        pass  # already recorded by timed()


def pct(vals: List[float], p: float) -> float:
    s = sorted(vals)
    return s[min(len(s) - 1, int(round((len(s) - 1) * p)))] if s else 0.0


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--access-code", required=True)
    ap.add_argument("-n", "--students", type=int, default=50)
    ap.add_argument("--ramp", type=float, default=5.0, help="spread student starts over this many seconds")
    ap.add_argument("--checkpoints", type=int, default=4)
    ap.add_argument("--run-timeout", type=float, default=120)
    ap.add_argument("--pip-timeout", type=float, default=400)
    ap.add_argument("--no-pip", action="store_true")
    args = ap.parse_args()
    args.base_url = args.base_url.rstrip("/")

    st = Stats()
    cache: Dict[str, Any] = {}
    gate = asyncio.Event()
    limits = httpx.Limits(max_connections=args.students * 2, max_keepalive_connections=args.students)
    async with httpx.AsyncClient(timeout=120, limits=limits) as client:
        h = (await client.get(f"{args.base_url}/health")).json()
        print(f"Server: {h.get('status')}, store={h.get('session_store')}, runner={h.get('code_runner')}")
        print(f"Starting {args.students} students (ramp {args.ramp}s)...")
        tasks = [asyncio.create_task(student(i, args, client, st, cache, gate)) for i in range(args.students)]
        t0 = time.perf_counter()
        gate.set()
        await asyncio.gather(*tasks)
        wall = time.perf_counter() - t0
        h2 = (await client.get(f"{args.base_url}/health")).json()

    cfg = cache.get("cfg") or {}
    print(f"\nSurvey config: pre={len((cfg.get('pre_survey') or {}).get('questions') or [])} questions, "
          f"post={len((cfg.get('post_survey') or {}).get('questions') or [])} questions")
    print(f"Total wall time: {wall:.1f}s\n")
    print(f"{'step':<15}{'ok':>5}{'fail':>6}{'skip':>6}{'p50 ms':>10}{'p95 ms':>10}{'max ms':>10}{'retry':>7}")
    for step in ["page_load", "quiz_join", "survey_config", "pre_survey", "checkpoint", "run_code",
                 "pip_install", "run_with_pkg", "post_survey"]:
        lat = st.lat.get(step, [])
        print(f"{step:<15}{st.ok[step]:>5}{len(st.errors[step]):>6}{st.skipped[step]:>6}"
              f"{pct(lat, .5):>10.0f}{pct(lat, .95):>10.0f}{max(lat or [0]):>10.0f}{st.retries[step]:>7}")
    print(f"\nServer after: {h2.get('code_runs_local') or h2.get('code_runner')}, active_sessions={h2.get('active_sessions')}")
    failed = {k: v for k, v in st.errors.items() if v}
    if failed:
        print("\nErrors (first 3 per step):")
        for k, v in failed.items():
            for e in v[:3]:
                print(f"  [{k}] {e}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
