"""AI assistance for study conditions 2 (inline ghost-text completion) and 3 (coding agent).

Kept free of main.py imports: callers pass in the OpenAI client and a code runner.
"""

import difflib
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional, Tuple

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

COMPLETION_MODEL = os.getenv("COMPLETION_MODEL", "gpt-5.4-nano")
# GPT-5 models think before answering; keep it off for fast inline suggestions ("minimal" for gpt-5-nano)
COMPLETION_REASONING_EFFORT = os.getenv("COMPLETION_REASONING_EFFORT", "none")
AGENT_MODEL = os.getenv("AGENT_MODEL", "gpt-4.1-mini")

AGENT_MODES = ("ask", "agent", "plan", "debug")
AGENT_MAX_STEPS = int(os.getenv("AGENT_MAX_STEPS", "15"))
MAX_FILES = 20
MAX_FILE_CHARS = 20000
_FILENAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")


# ─── Inline completion (condition 2) ─────────────────────────────────────────

_COMPLETION_SYSTEM = (
    "You are a code completion engine like GitHub Copilot. You receive a {language} file "
    "with a <CURSOR> marker. Reply with ONLY the exact text to insert at <CURSOR>: no "
    "explanations, no markdown fences, never repeat code that is already before or after "
    "the cursor. Finish the current line and, when the intent is clear, continue with the "
    "next lines of the same logical block (at most {max_lines} lines). Match the file's "
    "indentation. If nothing useful can be added, reply with nothing. Other files the "
    "student has open may be included before the file for reference: use their names, "
    "signatures and behavior, but only insert text into the file with <CURSOR>."
)

# Budget for other open editor tabs sent with each completion request
COMPLETION_MAX_OPEN_FILES = 5
COMPLETION_OPEN_FILE_CHARS = 3000
COMPLETION_OPEN_TOTAL_CHARS = 8000


def _open_files_context(open_files: List[Tuple[str, str]], filename: str) -> str:
    parts, total = [], 0
    for name, content in open_files[:COMPLETION_MAX_OPEN_FILES]:
        if name == filename or not content.strip():
            continue
        body = content[:COMPLETION_OPEN_FILE_CHARS]
        if total + len(body) > COMPLETION_OPEN_TOTAL_CHARS:
            break
        total += len(body)
        parts.append(f"--- {name} (open in another tab) ---\n{body}")
    return "\n\n".join(parts) + "\n\n" if parts else ""


def _strip_fences(text: str) -> str:
    m = re.match(r"^\s*```[\w+-]*\n(.*?)\n?```\s*$", text, re.S)
    return m.group(1) if m else text


def clean_completion(completion: str, prefix: str, suffix: str, max_lines: int) -> str:
    text = _strip_fences(completion.replace("\r\n", "\n")).replace("<CURSOR>", "")
    if not text.strip():
        return ""

    # Model sometimes repeats the partial current line; drop the duplicate.
    line_head = prefix.rsplit("\n", 1)[-1]
    if not line_head.strip():
        # Cursor sits in the line's indentation: drop indentation the editor already has,
        # otherwise the ghost text is over-indented and Tab indents instead of accepting.
        first, _, rest = text.partition("\n")
        stripped = first.lstrip(" \t")
        indent = first[: len(first) - len(stripped)]
        first = indent[len(line_head):] if indent.startswith(line_head) else ""
        text = first + stripped + ("\n" + rest if _ else "")
    elif text.startswith(line_head):
        text = text[len(line_head):]
    elif text.lstrip().startswith(line_head.strip()):
        text = text.lstrip()[len(line_head.strip()):]

    # Mid-line cursor (code to the right): single-line suggestion only, like Copilot.
    line_tail = suffix.split("\n", 1)[0]
    if line_tail.strip():
        text = text.split("\n", 1)[0]
        if text.endswith(line_tail.strip()):
            text = text[: -len(line_tail.strip())]

    # Drop any trailing overlap with the code after the cursor.
    tail = suffix.lstrip("\n")
    for k in range(min(len(text), len(tail)), 3, -1):
        if text.endswith(tail[:k]):
            text = text[:-k]
            break

    lines = text.rstrip().split("\n")[:max_lines]
    return "\n".join(lines).rstrip()


def completion_params(model: str, max_tokens: int) -> Dict[str, Any]:
    """Length/sampling settings for chat.completions: GPT-5 (reasoning) models take
    max_completion_tokens and reasoning_effort and reject temperature. They go in extra_body
    because the pinned openai SDK (1.35) predates these parameters."""
    if model.startswith(("gpt-5", "o1", "o3", "o4")):
        return {"extra_body": {"max_completion_tokens": max_tokens, "reasoning_effort": COMPLETION_REASONING_EFFORT}}
    return {"temperature": 0, "max_tokens": max_tokens}


async def inline_completion(
    client: AsyncOpenAI,
    *,
    language: str,
    filename: str,
    prefix: str,
    suffix: str,
    open_files: Optional[List[Tuple[str, str]]] = None,
    max_lines: int = 8,
) -> str:
    prefix = prefix[-4000:]
    suffix = suffix[:1500]
    context = _open_files_context(open_files or [], filename)
    resp = await client.chat.completions.create(
        model=COMPLETION_MODEL,
        **completion_params(COMPLETION_MODEL, 200),
        messages=[
            {"role": "system", "content": _COMPLETION_SYSTEM.format(language=language, max_lines=max_lines)},
            {"role": "user", "content": f"{context}File: {filename}\n{prefix}<CURSOR>{suffix}"},
        ],
    )
    return clean_completion(resp.choices[0].message.content or "", prefix, suffix, max_lines)


# ─── Agent (condition 3) ─────────────────────────────────────────────────────

_TOOL_DEFS: Dict[str, Dict[str, Any]] = {
    "list_files": {
        "description": "List the files in the student's workspace with their sizes.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    "read_file": {
        "description": "Read a file from the workspace (returns it with line numbers).",
        "parameters": {
            "type": "object",
            "properties": {"filename": {"type": "string"}},
            "required": ["filename"],
        },
    },
    "edit_file": {
        "description": (
            "Replace one exact occurrence of old_string with new_string in a file. old_string must "
            "match the file exactly (including indentation) and be unique; include surrounding lines "
            "to make it unique. Use this for targeted changes."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "filename": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
            },
            "required": ["filename", "old_string", "new_string"],
        },
    },
    "write_file": {
        "description": "Create a new file, or overwrite an existing file with the full new content.",
        "parameters": {
            "type": "object",
            "properties": {"filename": {"type": "string"}, "content": {"type": "string"}},
            "required": ["filename", "content"],
        },
    },
    "delete_file": {
        "description": "Delete a file from the workspace.",
        "parameters": {
            "type": "object",
            "properties": {"filename": {"type": "string"}},
            "required": ["filename"],
        },
    },
    "run_code": {
        "description": (
            "Run the program and return stdout/stderr. Runs `filename` as the entry point "
            "(null = the active file). If the program reads input (input(), scanf), pass the "
            "input lines in `stdin`, each ending with a newline; otherwise pass null."
        ),
        "parameters": {
            "type": "object",
            "properties": {"filename": {"type": ["string", "null"]}, "stdin": {"type": ["string", "null"]}},
            "required": ["filename", "stdin"],
        },
    },
    "install_package": {
        "description": (
            "pip install Python packages from PyPI into the student's environment (Python only). "
            "The student is asked to approve first and may decline. numpy, pandas and matplotlib "
            "are already installed."
        ),
        "parameters": {
            "type": "object",
            "properties": {"packages": {"type": "array", "items": {"type": "string"},
                                        "description": "Package names, optionally with versions, e.g. requests or flask==3.0"}},
            "required": ["packages"],
        },
    },
}

_READ_TOOLS = ["list_files", "read_file"]
_WRITE_TOOLS = _READ_TOOLS + ["edit_file", "write_file", "delete_file", "run_code"]
_MODE_TOOLS = {"ask": _READ_TOOLS, "plan": _READ_TOOLS, "agent": _WRITE_TOOLS, "debug": _WRITE_TOOLS}
MAX_INSTALL_PACKAGES = 10

_BASE_PROMPT = """You are an AI coding agent built into a browser IDE, working with a student the way Cursor's agent does.
Workspace language: {language}. Active file: {active_file}.
Keep replies concise and use Markdown. Refer to files by name. Never claim you ran or changed something you did not."""

_MODE_PROMPTS = {
    "ask": """Mode: ASK (chat only). Answer questions and explain code. You cannot modify files in this mode;
if the student wants changes, show short snippets and suggest switching to Agent mode.""",
    "plan": """Mode: PLAN. Investigate the code, then reply with a short numbered implementation plan
(what to change, in which file, and why). Do not write the full solution and do not modify files.
End by telling the student they can click "Build this plan" to have the agent carry it out.""",
    "agent": """Mode: AGENT. Make the changes the student asks for directly in their files using the tools.
Prefer edit_file for targeted changes and write_file for new files or full rewrites. After editing,
run the code when it helps confirm the change works. Finish with a brief summary of what you changed.""",
    "debug": """Mode: DEBUG. Find and fix the bug systematically. Always use run_code yourself; never ask
the student whether to run it.
1. Reproduce: call run_code first and read the actual error/output.
2. Form hypotheses about the root cause; add temporary print statements if you need more evidence.
3. Fix the root cause (not the symptom) with the smallest change.
4. Call run_code again to verify the fix, then remove any temporary prints.
Finish with: the cause, the fix, and the output that shows it works.""",
}


def _number_lines(content: str) -> str:
    lines = content.split("\n")
    if len(lines) > 1 and lines[-1] == "":  # trailing newline is not an extra line
        lines.pop()
    return "\n".join(f"{i:4}| {ln}" for i, ln in enumerate(lines, 1))


# ─── Git-style workspace history for the agent log ──────────────────────────
# The full code is stored once per problem (the first agent turn's "workspace_before"); after that,
# every turn stores only patches, like `git diff`:
#   workspace_diff_before  what changed since the previous turn ended (the student's own edits, Undo, ...)
#   edits[i].diff          each change the agent made, in order
# rebuild_workspaces() replays them to get the exact code at any turn.

def _file_diff(filename: str, before: Optional[str], after: Optional[str]) -> str:
    """Unified diff of one file (None = file absent). Complete, so it can be applied back exactly."""
    if before == after:
        return ""
    head = f"diff --git a/{filename} b/{filename}\n"
    if before is None:
        head += "new file\n"
    elif after is None:
        head += "deleted file\n"
    old, new = (before or "").splitlines(keepends=True), (after or "").splitlines(keepends=True)
    out = [head]
    for line in difflib.unified_diff(old, new, fromfile="/dev/null" if before is None else f"a/{filename}",
                                     tofile="/dev/null" if after is None else f"b/{filename}"):
        out.append(line)
        if not line.endswith("\n"):  # last line of a file without a trailing newline
            out.append("\n\\ No newline at end of file\n")
    return "".join(out)


def ws_to_list(ws: Dict[str, str]) -> List[Dict[str, str]]:
    return [{"filename": n, "content": c} for n, c in ws.items()]


def ws_from_list(files: Any) -> Dict[str, str]:
    if isinstance(files, dict):  # older records
        return dict(files)
    return {f["filename"]: f.get("content") or "" for f in files or [] if isinstance(f, dict) and f.get("filename")}


def workspace_diff(before: Dict[str, str], after: Dict[str, str]) -> str:
    """git-diff-style patch turning workspace `before` into `after` (empty string: no change)."""
    return "".join(_file_diff(n, before.get(n), after.get(n)) for n in sorted(set(before) | set(after)))


def apply_workspace_diff(ws: Dict[str, str], patch: str) -> Dict[str, str]:
    """Apply a patch from workspace_diff()/_file_diff() to a workspace and return the new workspace."""
    out = dict(ws)
    blocks = re.split(r"^diff --git a/(.+?) b/.+\n", patch, flags=re.M)
    for name, body in zip(blocks[1::2], blocks[2::2]):
        if body.startswith("deleted file\n"):
            out.pop(name, None)
            continue
        old = (out.get(name) or "").splitlines(keepends=True)
        new: List[str] = []
        pos = 0  # next unconsumed line of `old`
        side = ""  # which side the previous hunk line was on, for "\ No newline at end of file"
        for line in body.splitlines(keepends=True):
            if line.startswith(("---", "+++", "new file")):
                continue
            m = re.match(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@", line)
            if m:
                start = int(m.group(1)) - (0 if m.group(2) == "0" else 1)
                new.extend(old[pos:start])
                pos = start
                continue
            if line.startswith("\\"):
                if side in (" ", "+") and new:
                    new[-1] = new[-1].rstrip("\n")
                continue
            tag, text = line[:1], line[1:]
            if tag == " ":
                new.append(old[pos])
                pos += 1
            elif tag == "-":
                pos += 1
            elif tag == "+":
                new.append(text)
            side = tag
        new.extend(old[pos:])
        out[name] = "".join(new)
    return out


def rebuild_workspaces(agent_log: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """For analysis: replay one session's agent_log and return, per turn, the full code before and after it.

    Returns [{"turn_id", "problem_index", "before": {file: code}, "after": {file: code}}, ...].
    """
    out: List[Dict[str, Any]] = []
    ws: Dict[str, str] = {}
    for rec in agent_log:
        if rec.get("workspace_before") is not None:
            ws = ws_from_list(rec["workspace_before"])
        elif rec.get("workspace_diff_before"):
            ws = apply_workspace_diff(ws, rec["workspace_diff_before"])
        before = dict(ws)
        for e in rec.get("edits") or []:
            ws = apply_workspace_diff(ws, e.get("diff") or "")
        out.append({"turn_id": rec.get("turn_id"), "problem_index": rec.get("problem_index"),
                    "before": before, "after": dict(ws)})
    return out


def _can_install(mode: str, language: str) -> bool:
    return mode in ("agent", "debug") and (language or "").lower() == "python"


def build_system_prompt(mode: str, language: str, active_file: str, skills: List[Dict[str, str]]) -> str:
    parts = [_BASE_PROMPT.format(language=language, active_file=active_file or "(none)"), _MODE_PROMPTS[mode]]
    if _can_install(mode, language):
        parts.append("If the code needs a package that is not installed (ModuleNotFoundError), call install_package "
                     "right away: do not ask for permission in chat or tell the student to run pip, because the tool "
                     "itself asks the student to approve. If the student declines, do not try again; work without "
                     "the package or explain what they can do.")
    if skills:
        parts.append(
            "## Skills\nFollow these skills whenever they are relevant:\n\n"
            + "\n\n".join(f"### {s.get('name', 'Skill')}\n{s.get('instructions', '').strip()}" for s in skills)
        )
    return "\n\n".join(parts)


def _workspace_context(ws: Dict[str, str], terminal_output: Optional[str]) -> str:
    total = sum(len(c) for c in ws.values())
    if total <= 24000:
        body = "\n\n".join(f"### {name}\n```\n{_number_lines(c)}\n```" for name, c in ws.items())
    else:
        body = "Files: " + ", ".join(ws) + " (use read_file to see contents)"
    ctx = "<workspace>\n" + body + "\n</workspace>"
    if terminal_output and terminal_output.strip():
        ctx += "\n<terminal_output>\n" + terminal_output[-3000:] + "\n</terminal_output>"
    return ctx


RunCode = Callable[[str, List[Dict[str, str]], str, Optional[str]], Awaitable[Dict[str, Any]]]
InstallPackages = Callable[[List[str]], Awaitable[Dict[str, Any]]]
# Waits for the student's answer to an install request: "always" | "once" | "deny" | "timeout"
WaitApproval = Callable[[str], Awaitable[str]]


class AgentTurn:
    """One student message → streamed events, plus a log record for research analysis."""

    def __init__(
        self,
        client: AsyncOpenAI,
        *,
        mode: str,
        message: str,
        history: List[Dict[str, str]],
        files: List[Dict[str, str]],
        active_file: str,
        language: str,
        skills: List[Dict[str, str]],
        terminal_output: Optional[str],
        run_code: RunCode,
        base_ws: Optional[Dict[str, str]] = None,
        install_packages: Optional[InstallPackages] = None,
        wait_approval: Optional[WaitApproval] = None,
        auto_install: bool = False,
    ):
        self.client = client
        self.mode = mode if mode in AGENT_MODES else "ask"
        self.message = message
        self.history = history
        self.ws: Dict[str, str] = {f["filename"]: f["content"] for f in files}
        self.initial = dict(self.ws)
        self.active_file = active_file if active_file in self.ws else next(iter(self.ws), "")
        self.language = language
        self.skills = skills
        self.terminal_output = terminal_output
        self.run_code = run_code
        self.install_packages = install_packages
        self.wait_approval = wait_approval
        self.auto_install = auto_install  # the student chose "Always allow" earlier
        self.record: Dict[str, Any] = {
            "turn_id": uuid.uuid4().hex[:12],
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "mode": self.mode,
            "model": AGENT_MODEL,
            "message": message,  # what the student typed (the prompt)
            "active_file": self.active_file,
            "history_messages": len(history[-20:]),  # earlier chat messages sent along
            "skills": [s.get("name", "") for s in skills],
            # Code when the prompt was sent, git style: the full workspace on the first turn of a problem,
            # otherwise only a patch against the end of the previous turn (base_ws). See rebuild_workspaces().
            # Lists, not {filename: code}: Firebase keys can't contain "." (main.py)
            "workspace_before": ws_to_list(self.ws) if base_ws is None else None,
            "workspace_diff_before": workspace_diff(base_ws, self.ws) if base_ws is not None else None,
            "response": "",
            "tool_calls": [],
            "edits": [],
            "installs": [],  # install_package requests: packages, decision, wait_ms, success
            "usage": {},
            # Filled in as the turn runs (see run() and main.agent_chat):
            # index, problem_index, ended_at, duration_ms, first_output_ms, status,
            # lines_added_total, lines_removed_total, files_changed
        }
        self._t0 = time.monotonic()
        self._partial_text = ""  # text of the current model step, kept if the student stops mid-answer

    def _installable(self) -> bool:
        return _can_install(self.mode, self.language) and self.install_packages is not None

    # Tool implementations -------------------------------------------------

    def _check_name(self, name: str) -> Optional[str]:
        if not _FILENAME_RE.match(name or ""):
            return "Invalid filename: use a simple name like utils.py (no folders)."
        return None

    async def _tool(self, name: str, args: Dict[str, Any]) -> Tuple[str, Optional[Dict[str, Any]]]:
        """Return (result text for the model, optional event for the client)."""
        fn = args.get("filename") or ""
        if name == "list_files":
            return "\n".join(f"{n} ({len(c.splitlines())} lines)" for n, c in self.ws.items()) or "(no files)", None
        if name == "read_file":
            if fn not in self.ws:
                return f"File not found: {fn}. Files: {', '.join(self.ws)}", None
            return _number_lines(self.ws[fn]), None
        if name == "edit_file":
            if fn not in self.ws:
                return f"File not found: {fn}", None
            if not isinstance(args.get("old_string"), str) or not isinstance(args.get("new_string"), str):
                return "edit_file needs both old_string and new_string. Nothing was changed.", None
            old, new = args["old_string"], args["new_string"]
            if self.ws[fn].count(old) == 0 and old.strip() and self.ws[fn].count(old.rstrip()) == 1:
                # Model often adds stray trailing whitespace; match without it.
                old, new = old.rstrip(), new.rstrip() if new.endswith(old[len(old.rstrip()):]) else new
            if self.ws[fn].strip() and not self.ws[fn].replace(old, new, 1).strip():
                return ("That edit would erase the whole file, so it was not applied. Use write_file "
                        "with the full new content, or delete_file to remove the file."), None
            count = self.ws[fn].count(old) if old else 0
            if count != 1:
                return (f"old_string matched {count} times in {fn}; it must match exactly once. "
                        "Re-read the file and include more surrounding lines."), None
            return self._apply(fn, self.ws[fn].replace(old, new, 1), "edit")
        if name == "write_file":
            err = self._check_name(fn)
            if err:
                return err, None
            if fn not in self.ws and len(self.ws) >= MAX_FILES:
                return f"Workspace already has {MAX_FILES} files.", None
            return self._apply(fn, args.get("content", ""), "create" if fn not in self.ws else "write")
        if name == "delete_file":
            if fn not in self.ws:
                return f"File not found: {fn}", None
            if len(self.ws) == 1:
                return "Cannot delete the only file in the workspace.", None
            before = self.ws.pop(fn)
            self._log_edit(fn, "delete", before, "")
            return f"Deleted {fn}.", {"type": "file", "action": "delete", "filename": fn}
        if name == "run_code":
            entry = fn or self.active_file
            if entry not in self.ws:
                return f"File not found: {entry}", None
            files = [{"filename": n, "content": c} for n, c in self.ws.items()]
            stdin = args.get("stdin") if isinstance(args.get("stdin"), str) else None
            res = await self.run_code(self.ws[entry], files, self.language, stdin)
            out = (res.get("output") or "")[-4000:]
            errout = (res.get("error") or "")[-4000:]
            text = f"success={res.get('success')}\nstdout:\n{out or '(empty)'}\nstderr:\n{errout or '(empty)'}"
            return text, {"type": "run", "filename": entry, "success": bool(res.get("success")),
                          "output": out, "error": errout}
        if name == "install_package":
            return await self._install(args)
        return f"Unknown tool: {name}", None

    async def _install(self, args: Dict[str, Any]) -> Tuple[str, Optional[Dict[str, Any]]]:
        pkgs = [str(p).strip() for p in args.get("packages") or [] if str(p).strip()][:MAX_INSTALL_PACKAGES]
        decision = args.get("_decision", "deny")
        entry = {"packages": pkgs, "decision": decision, "wait_ms": args.get("_wait_ms", 0),
                 "at_ms": int((time.monotonic() - self._t0) * 1000)}
        self.record["installs"].append(entry)
        if decision not in ("always", "once"):
            return ("The student did not approve installing " + ", ".join(pkgs) + ". Do not ask again in this turn; "
                    "continue without it or explain what is needed."), None
        if self.install_packages is None:
            return "Installing packages is not available here.", None
        res = await self.install_packages(pkgs)
        out = (res.get("output") or "")[-3000:]
        entry["success"] = bool(res.get("success"))
        return (f"success={res.get('success')}\n{out or '(no output)'}",
                {"type": "install", "packages": pkgs, "success": bool(res.get("success")), "output": out})

    def _apply(self, fn: str, content: str, action: str) -> Tuple[str, Optional[Dict[str, Any]]]:
        if len(content) > MAX_FILE_CHARS:
            return f"Content too long (max {MAX_FILE_CHARS} characters).", None
        before = self.ws.get(fn, "")
        self.ws[fn] = content
        added, removed = self._log_edit(fn, action, before, content)
        return (f"{'Created' if action == 'create' else 'Updated'} {fn} (+{added} -{removed}).",
                {"type": "file", "action": action, "filename": fn, "content": content,
                 "added": added, "removed": removed})

    def _log_edit(self, fn: str, action: str, before: str, after: str) -> Tuple[int, int]:
        """Record one file change: lines added/removed and the complete patch (see rebuild_workspaces)."""
        full = list(difflib.unified_diff(before.splitlines(), after.splitlines(), lineterm=""))
        added = sum(1 for ln in full if ln.startswith("+") and not ln.startswith("+++"))
        removed = sum(1 for ln in full if ln.startswith("-") and not ln.startswith("---"))
        self.record["edits"].append({
            "filename": fn, "action": action,
            "at_ms": int((time.monotonic() - self._t0) * 1000),
            "lines_added": added, "lines_removed": removed,
            "diff": _file_diff(fn, None if action == "create" else before, None if action == "delete" else after),
        })
        return added, removed

    def finish(self, status: str) -> None:
        """Stamp timing and totals; called once when the turn ends (completed, stopped or error)."""
        if "status" in self.record:
            return
        if status != "completed" and self._partial_text:
            self.record["response"] += ("\n\n" if self.record["response"] else "") + self._partial_text
        self.record["status"] = status
        self.record["ended_at"] = datetime.now(timezone.utc).isoformat()
        self.record["duration_ms"] = int((time.monotonic() - self._t0) * 1000)
        self.record["lines_added_total"] = sum(e["lines_added"] for e in self.record["edits"])
        self.record["lines_removed_total"] = sum(e["lines_removed"] for e in self.record["edits"])
        self.record["files_changed"] = sorted(
            n for n in set(self.initial) | set(self.ws) if self.initial.get(n) != self.ws.get(n)
        )

    # Main loop ------------------------------------------------------------

    async def run(self) -> AsyncIterator[Dict[str, Any]]:
        # strict: the model must send every argument (a missing new_string once erased files)
        tools = [
            {"type": "function", "function": {
                "name": n, "strict": True, **_TOOL_DEFS[n],
                "parameters": {**_TOOL_DEFS[n]["parameters"], "additionalProperties": False},
            }}
            for n in _MODE_TOOLS[self.mode] + (["install_package"] if self._installable() else [])
        ]
        system_prompt = build_system_prompt(self.mode, self.language, self.active_file, self.skills)
        self.record["system_prompt"] = system_prompt
        messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]
        for h in self.history[-20:]:
            if h.get("role") in ("user", "assistant") and h.get("content"):
                messages.append({"role": h["role"], "content": str(h["content"])[:8000]})
        messages.append({"role": "user", "content": _workspace_context(self.ws, self.terminal_output)
                         + "\n\n" + self.message})
        # Sent first so the client can tie Keep/Undo decisions to this turn.
        yield {"type": "start", "turn_id": self.record["turn_id"]}

        usage = {"prompt_tokens": 0, "completion_tokens": 0}
        self.record["usage"] = usage  # same dict, so a stopped turn keeps its partial token counts
        for _step in range(AGENT_MAX_STEPS):
            stream = await self.client.chat.completions.create(
                model=AGENT_MODEL, messages=messages, tools=tools, temperature=0.2,
                stream=True, stream_options={"include_usage": True},
            )
            text, calls = "", {}
            async for chunk in stream:
                if chunk.usage:
                    usage["prompt_tokens"] += chunk.usage.prompt_tokens
                    usage["completion_tokens"] += chunk.usage.completion_tokens
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content:
                    self.record.setdefault("first_output_ms", int((time.monotonic() - self._t0) * 1000))
                    text += delta.content
                    self._partial_text = text
                    yield {"type": "text", "delta": delta.content}
                for tc in delta.tool_calls or []:
                    c = calls.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                    c["id"] = tc.id or c["id"]
                    if tc.function:
                        c["name"] += tc.function.name or ""
                        c["arguments"] += tc.function.arguments or ""
            self._partial_text = ""
            if text:
                self.record["response"] += ("\n\n" if self.record["response"] else "") + text

            if not calls:
                break
            ordered = [calls[i] for i in sorted(calls)]
            messages.append({
                "role": "assistant", "content": text or None,
                "tool_calls": [{"id": c["id"], "type": "function",
                                "function": {"name": c["name"], "arguments": c["arguments"] or "{}"}} for c in ordered],
            })
            for c in ordered:
                try:
                    args = json.loads(c["arguments"] or "{}")
                except json.JSONDecodeError:
                    args = {}
                label = args.get("filename") or ""
                if c["name"] == "install_package":
                    # Ask the student first (like Cursor), unless they chose "Always allow".
                    pkgs = [str(p).strip() for p in args.get("packages") or [] if str(p).strip()][:MAX_INSTALL_PACKAGES]
                    label = ", ".join(pkgs)
                    approval_id = uuid.uuid4().hex[:12]
                    if self.auto_install:
                        args["_decision"] = "always"
                    elif self.wait_approval is None or not pkgs:
                        args["_decision"] = "deny"
                    else:
                        yield {"type": "approval", "id": approval_id, "packages": pkgs}
                        asked = time.monotonic()
                        args["_decision"] = await self.wait_approval(approval_id)
                        args["_wait_ms"] = int((time.monotonic() - asked) * 1000)
                    if args["_decision"] == "always":
                        self.auto_install = True
                    yield {"type": "approval_result", "id": approval_id, "packages": pkgs,
                           "decision": args["_decision"], "auto": "_wait_ms" not in args and args["_decision"] == "always"}
                yield {"type": "tool", "name": c["name"], "filename": label}
                result, event = await self._tool(c["name"], args)
                self.record["tool_calls"].append({"name": c["name"], "filename": label, "result": result[:500]})
                if event:
                    yield event
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": result})
        else:
            note = "\n\n_(Stopped after the maximum number of steps.)_"
            self.record["response"] += note
            yield {"type": "text", "delta": note}

        self.record["usage"] = usage
        self.finish("completed")
        yield {"type": "done", "turn_id": self.record["turn_id"]}
