#!/usr/bin/env python3
"""
Stress test with AI: N simulated students (default 50) do a whole quiz session at the same time,
using the real AI endpoints (OpenAI is called for real, so this costs a little).

Each student:
  1. opens the quiz page and joins (the server picks condition 2 = inline suggestions or 3 = agent)
  2. answers the pre survey
  3. codes for a few rounds:
       condition 2: types, asks /complete for ghost text, accepts or rejects it (logged like the browser)
       condition 3: sends agent messages (ask / agent / debug), approves package installs,
                    then Keeps or Undoes each edit (/agent/decision)
     with editor checkpoints, activity log batches, a program run, and recurrent check-in surveys
  4. answers the post survey and submits the code

User IDs start with "stresstest_" so the records can be found and removed afterwards.

  python scripts/stress_ai_students.py --access-code 2xGRMXwK -n 50
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

from stress_50_students import DEFAULT_SURVEYS, Stats, answer_for, pct, survey_payload

PROGRAM_LINES = [
    "def average(nums):\n",
    "    if not nums:\n",
    "        return 0\n",
    "    return sum(nums) / len(nums)\n",
    "\n",
    "def grade(score):\n",
    "    if score >= 90:\n",
    "        return 'A'\n",
    "    elif score >= 80:\n",
    "        return 'B'\n",
    "    return 'C'\n",
    "\n",
    "scores = [88, 92, 75, 100]\n",
    "print(average(scores), [grade(s) for s in scores])\n",
]

AGENT_PROMPTS = [
    ("ask", "What does my average function do, and is there an edge case I missed?"),
    ("agent", "Add a function median(nums) to main.py and print the median of scores."),
    ("debug", "My program prints the wrong grade for 80. Run it and fix it if needed."),
    ("agent", "Add a docstring to every function in main.py."),
]

FALLBACK_RECURRENT = ["I trust the AI's responses.", "I am confident in the AI's responses."]

STEPS = ["page_load", "quiz_join", "survey_config", "pre_survey", "checkpoint", "log_activities",
         "complete", "agent_turn", "agent_decision", "recurrent_survey", "run_code", "post_survey", "submit"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def activity(kind: str, details: Dict[str, Any], code: str) -> Dict[str, Any]:
    return {"timestamp": now_iso(), "activity_type": kind, "activity_details": details,
            "session_context": {"total_lines": code.count("\n") + 1, "stress_test": True}}


class AgentStats:
    def __init__(self) -> None:
        self.first_output_ms: List[float] = []
        self.turn_ms: List[float] = []
        self.tool_calls = 0
        self.edits = 0
        self.approvals = 0
        self.turn_errors: List[str] = []


async def agent_turn(client: httpx.AsyncClient, base: str, payload: Dict[str, Any], sid: str,
                     ag: AgentStats, timeout: float) -> Dict[str, Any]:
    """One streamed /agent/chat turn. Returns {turn_id, files: {name: content|None}, text, error}."""
    out: Dict[str, Any] = {"turn_id": "", "files": {}, "text": "", "error": None}
    t0 = time.perf_counter()
    first = None
    async with client.stream("POST", f"{base}/agent/chat", json=payload, timeout=timeout) as r:
        if r.status_code != 200:
            out["error"] = f"HTTP {r.status_code}: {(await r.aread())[:150]!r}"
            return out
        buf = ""
        async for chunk in r.aiter_text():
            buf += chunk
            *events, buf = buf.split("\n\n")
            for raw in events:
                if not raw.startswith("data: "):
                    continue
                ev = json.loads(raw[6:])
                t = ev.get("type")
                if t in ("text", "tool", "file", "run", "approval") and first is None:
                    first = (time.perf_counter() - t0) * 1000
                if t == "start":
                    out["turn_id"] = ev["turn_id"]
                elif t == "text":
                    out["text"] += ev.get("delta", "")
                elif t == "tool":
                    ag.tool_calls += 1
                elif t == "file":
                    ag.edits += 1
                    out["files"][ev["filename"]] = None if ev.get("action") == "delete" else ev.get("content")
                elif t == "approval":
                    # The student clicks "Allow once" a couple of seconds later
                    ag.approvals += 1
                    await asyncio.sleep(random.uniform(1, 3))
                    await client.post(f"{base}/agent/approve", json={
                        "session_id": sid, "approval_id": ev["id"], "decision": "once"})
                elif t == "error":
                    out["error"] = ev.get("message")
    if first is not None:
        ag.first_output_ms.append(first)
    ag.turn_ms.append((time.perf_counter() - t0) * 1000)
    return out


async def student(idx: int, args: argparse.Namespace, client: httpx.AsyncClient, st: Stats,
                  ag: AgentStats, conds: Dict[int, int], cache: Dict[str, Any], gate: asyncio.Event) -> None:
    base = args.base_url
    user_id = f"stresstest_ai_{idx:02d}_{uuid.uuid4().hex[:6]}"
    await gate.wait()
    await asyncio.sleep(random.uniform(0, args.ramp))

    async def call(step: str, make, ok=lambda r: r.status_code == 200):
        """Time one request and record it; returns the response or None on failure."""
        t = time.perf_counter()
        try:
            try:
                r = await make()
            except httpx.RemoteProtocolError:
                st.retries[step] += 1
                r = await make()
        except Exception as e:
            st.record(step, (time.perf_counter() - t) * 1000, f"{type(e).__name__}: {e}"[:200])
            return None
        ms = (time.perf_counter() - t) * 1000
        good = ok(r)
        st.record(step, ms, None if good else f"HTTP {r.status_code}: {r.text[:150]}")
        return r if good else None

    def think(lo: float, hi: float):
        return asyncio.sleep(random.uniform(lo, hi) * args.think)

    # 1. Join
    await call("page_load", lambda: client.get(f"{base}/quiz/{args.access_code}"))
    r = await call("quiz_join", lambda: client.post(f"{base}/quiz/join", json={
        "access_code": args.access_code, "user_id": user_id, "programming_language": "python"}),
        ok=lambda r: r.status_code == 200 and r.json().get("status") == "success")
    if r is None:
        return
    data = r.json()
    sid, quiz_id, cond = data["session_id"], data["quiz_id"], int(data.get("condition") or 0)
    conds[cond] = conds.get(cond, 0) + 1
    key = f"quiz_{str(quiz_id)[:8].lower()}"

    # 2. Pre survey
    r = await call("survey_config", lambda: client.get(f"{base}/survey-config/{key}",
                                                       params={"problem_index": 0, "session_id": sid}))
    cfg = r.json() if r is not None else {}
    cache.setdefault("cfg", cfg)
    pre = cfg.get("pre_survey") or {}
    post = cfg.get("post_survey") or {}
    rec_qs = (cfg.get("periodic_survey") or {}).get("questions") or FALLBACK_RECURRENT
    if not pre.get("questions"):
        pre = {"title": "Pre-Study Survey", "questions": DEFAULT_SURVEYS["pre"]}
    if not post.get("questions"):
        post = {"title": "Post-Study Survey", "questions": DEFAULT_SURVEYS["post"]}
    await think(2, 6)
    await call("pre_survey", lambda: client.post(f"{base}/submit-pre-post-survey",
                                                 json=survey_payload(pre, "pre", user_id, sid, key)),
               ok=lambda r: r.status_code == 200 and r.json().get("status") == "success")

    # 3. Coding rounds
    files = {"main.py": ""}
    pending_acts: List[Dict[str, Any]] = []
    all_acts: List[Dict[str, Any]] = []
    history: List[Dict[str, str]] = []
    occurrence = 0

    def act(kind: str, details: Dict[str, Any]) -> None:
        a = activity(kind, details, files["main.py"])
        pending_acts.append(a)
        all_acts.append(a)

    async def flush() -> None:
        if not pending_acts:
            return
        batch = pending_acts[:]
        pending_acts.clear()
        await call("log_activities", lambda: client.post(f"{base}/log-activities", json={
            "activities": batch, "session_id": sid, "user_id": user_id, "assignment_key": key, "quiz_id": quiz_id}))

    async def recurrent_survey() -> None:
        nonlocal occurrence
        occurrence += 1
        shown = time.time()
        await think(4, 10)
        responses = [{"question": q if isinstance(q, str) else q.get("question", ""),
                      "response": random.randint(1, 5) if isinstance(q, str) else answer_for(q)} for q in rec_qs]
        await call("recurrent_survey", lambda: client.post(f"{base}/submit-survey", json={
            "user_id": user_id, "session_id": sid, "assignment_key": key, "survey_type": "periodic",
            "responses": responses, "analysis_count": occurrence, "timestamp": now_iso(),
            "problem_index": 0, "occurrence": occurrence,
            "shown_at": datetime.fromtimestamp(shown, timezone.utc).isoformat(),
            "duration_seconds": round(time.time() - shown, 1), "trigger": "interval", "display": "side_panel"}))

    for rnd in range(args.rounds):
        # Type a few lines
        start = rnd * 3
        for line in PROGRAM_LINES[start:start + 3]:
            files["main.py"] += line
            act("code_editing_insert", {"text": line[:80]})
            await think(1, 3)

            if cond == 2:
                code = files["main.py"]
                r = await call("complete", lambda: client.post(f"{base}/complete", json={
                    "session_id": sid, "language": "python", "filename": "main.py",
                    "prefix": code, "suffix": "", "open_files": []}))
                text = (r.json().get("completion") or "") if r is not None else ""
                if text:
                    sug_id = r.json().get("id", "")
                    act("inline_suggestion_shown", {"suggestion_id": sug_id, "text": text[:2000], "file": "main.py",
                                                    "line": code.count("\n") + 1, "code_snapshot": code[-10000:]})
                    await think(0.5, 2)
                    if random.random() < 0.5:
                        files["main.py"] += text
                        act("inline_suggestion_accepted", {"suggestion_id": sug_id, "time_to_decision_ms": 1200})
                    else:
                        act("inline_suggestion_dismissed", {"suggestion_id": sug_id, "decision": "rejected",
                                                            "reason": "escape", "time_to_decision_ms": 900})

        await call("checkpoint", lambda: client.post(f"{base}/checkpoint-editor", json={
            "session_id": sid, "user_id": user_id, "assignment_key": key, "code": files["main.py"],
            "programming_language": "python", "current_problem_index": 0}))

        if cond == 3 and rnd < len(AGENT_PROMPTS):
            mode, prompt = AGENT_PROMPTS[rnd]
            payload = {"session_id": sid, "mode": mode, "message": prompt, "language": "python",
                       "files": [{"filename": n, "content": c} for n, c in files.items()],
                       "active_file": "main.py", "history": history[-20:], "skills": [], "terminal_output": ""}
            act("agent_message_sent", {"mode": mode, "length": len(prompt)})
            t = time.perf_counter()
            try:
                res = await agent_turn(client, base, payload, sid, ag, args.agent_timeout)
                err = res["error"]
            except Exception as e:
                res, err = {"turn_id": "", "files": {}, "text": ""}, f"{type(e).__name__}: {e}"[:200]
            st.record("agent_turn", (time.perf_counter() - t) * 1000, err)
            if err:
                ag.turn_errors.append(err)
            history += [{"role": "user", "content": prompt}, {"role": "assistant", "content": res["text"][:4000]}]
            # Review the edits: mostly Keep, sometimes Undo
            before = dict(files)
            for name, content in res["files"].items():
                await think(1, 4)
                decision = "keep" if random.random() < 0.75 else "undo"
                if decision == "keep":
                    if content is None:
                        files.pop(name, None)
                    else:
                        files[name] = content
                act("agent_edit_decision", {"filename": name, "decision": decision, "turn_id": res["turn_id"]})
                await call("agent_decision", lambda: client.post(f"{base}/agent/decision", json={
                    "session_id": sid, "turn_id": res["turn_id"], "filename": name, "decision": decision,
                    "time_to_decision_ms": 2000}))
            if "main.py" not in files:
                files["main.py"] = before.get("main.py", "")

        if rnd == args.rounds // 2:
            await call("run_code", lambda: client.post(f"{base}/execute", json={
                "code": files["main.py"], "language": "python", "user_id": user_id, "session_id": sid,
                "files": [{"filename": n, "content": c} for n, c in files.items()]}),
                ok=lambda r: r.status_code == 200 and "success" in r.json())
            act("code_execution", {"language": "python"})

        if (rnd + 1) % args.survey_every == 0:
            await recurrent_survey()
        await flush()

    # 4. Post survey and submit
    await think(3, 8)
    await call("post_survey", lambda: client.post(f"{base}/submit-pre-post-survey",
                                                  json=survey_payload(post, "post", user_id, sid, key)),
               ok=lambda r: r.status_code == 200 and r.json().get("status") == "success")
    await flush()
    if not args.no_submit:
        code = files["main.py"] or "print('stress test')\n"
        await call("submit", lambda: client.post(f"{base}/submit", json={
            "code": code, "user_id": user_id, "assignment_key": key, "session_id": sid,
            "programming_language": "python", "timestamp": now_iso(),
            "files": [{"filename": n, "content": c} for n, c in files.items()], "activity_logs": all_acts}),
            ok=lambda r: r.status_code == 200 and r.json().get("status") in ("success", "already_submitted"))


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--access-code", required=True)
    ap.add_argument("-n", "--students", type=int, default=50)
    ap.add_argument("--ramp", type=float, default=10.0, help="spread student starts over this many seconds")
    ap.add_argument("--rounds", type=int, default=4, help="coding rounds per student")
    ap.add_argument("--survey-every", type=int, default=2, help="recurrent survey every N rounds")
    ap.add_argument("--think", type=float, default=1.0, help="multiply all student think times (0 = no pauses)")
    ap.add_argument("--agent-timeout", type=float, default=240)
    ap.add_argument("--no-submit", action="store_true")
    args = ap.parse_args()
    args.base_url = args.base_url.rstrip("/")

    st, ag = Stats(), AgentStats()
    conds: Dict[int, int] = {}
    cache: Dict[str, Any] = {}
    gate = asyncio.Event()
    limits = httpx.Limits(max_connections=args.students * 3, max_keepalive_connections=args.students)
    async with httpx.AsyncClient(timeout=180, limits=limits) as client:
        h = (await client.get(f"{args.base_url}/health")).json()
        print(f"Server: {h.get('status')}, store={h.get('session_store')}, runner={h.get('code_runner')}")
        print(f"Starting {args.students} students (ramp {args.ramp}s, {args.rounds} rounds)...")
        tasks = [asyncio.create_task(student(i, args, client, st, ag, conds, cache, gate)) for i in range(args.students)]
        t0 = time.perf_counter()
        gate.set()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        wall = time.perf_counter() - t0
        h2 = (await client.get(f"{args.base_url}/health")).json()

    crashed = [r for r in results if isinstance(r, Exception)]
    print(f"\nConditions: {dict(sorted(conds.items()))}   wall time: {wall:.1f}s   crashed students: {len(crashed)}")
    print(f"\n{'step':<18}{'ok':>6}{'fail':>6}{'p50 ms':>10}{'p95 ms':>10}{'max ms':>10}{'retry':>7}")
    for step in STEPS:
        lat = st.lat.get(step, [])
        if not lat:
            continue
        print(f"{step:<18}{st.ok[step]:>6}{len(st.errors[step]):>6}"
              f"{pct(lat, .5):>10.0f}{pct(lat, .95):>10.0f}{max(lat):>10.0f}{st.retries[step]:>7}")
    if ag.turn_ms:
        print(f"\nAgent: {len(ag.turn_ms)} turns, {ag.tool_calls} tool calls, {ag.edits} edits, "
              f"{ag.approvals} install approvals")
        print(f"  first output p50 {pct(ag.first_output_ms, .5)/1000:.1f}s  p95 {pct(ag.first_output_ms, .95)/1000:.1f}s"
              f"   whole turn p50 {pct(ag.turn_ms, .5)/1000:.1f}s  p95 {pct(ag.turn_ms, .95)/1000:.1f}s")
    print(f"\nServer after: active_sessions={h2.get('active_sessions')}")
    failed = {k: v for k, v in st.errors.items() if v}
    if failed or crashed:
        print("\nErrors (first 3 per step):")
        for k, v in failed.items():
            for e in v[:3]:
                print(f"  [{k}] {e}")
        for e in crashed[:3]:
            print(f"  [crash] {type(e).__name__}: {e}")
    return 1 if failed or crashed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
