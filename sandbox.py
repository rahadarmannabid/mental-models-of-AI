"""Guarded execution of student code (Python, C) with live output and interactive stdin.

Guardrails (all configurable via env, see LIMITS below):
- Server-wide cap on concurrent runs, with a short queue; extra runs get a "server busy" message.
- One run per session at a time (starting a new run stops the old one) and a per-session rate limit.
- Per-process limits: CPU seconds, wall-clock time, idle time, memory, file size, open files.
- Output cap: the program is stopped once it prints too much.
- Each run gets a private temp directory that is deleted afterwards; filenames are sanitized.
- Python runs behind an audit hook that blocks subprocesses, network access, ctypes and file
  access outside the run directory. When the process runs as root (the runner container), each
  program additionally runs as an unprivileged SANDBOX_UID with a process-count limit.
- Pictures: matplotlib figures, turtle drawings (sandbox_shims/) and image files a program saves
  are sent to the browser as "display" events over a separate pipe.
- Packages: `pip install` puts wheels (never source builds) in a private environment per session
  on top of the preinstalled packages, with size quotas. It is deleted when the session submits
  (clear_packages) or after CODE_PKG_TTL_HOURS without use.

This module is used directly by main.py in local development, and by runner.py (a separate
container without secrets or internet access) in production.
"""

import asyncio
import base64
import codecs
import collections
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import sys
import tempfile
import time
from typing import Any, Awaitable, Callable, Deque, Dict, List, Optional, Tuple

try:
    import resource  # POSIX only
except ImportError:  # pragma: no cover
    resource = None  # type: ignore[assignment]


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


LIMITS = {
    "max_concurrent": _env_int("CODE_MAX_CONCURRENT", 40),     # runs at once (keep max_concurrent × memory_mb under the runner's RAM)
    "queue_seconds": _env_int("CODE_QUEUE_SECONDS", 45),       # max wait for a free slot
    "runs_per_minute": _env_int("CODE_RUNS_PER_MINUTE", 20),   # per session
    "cpu_seconds": _env_int("CODE_CPU_SECONDS", 10),
    "wall_seconds": _env_int("CODE_WALL_SECONDS", 120),        # interactive run, includes waiting for input
    "batch_wall_seconds": _env_int("CODE_BATCH_WALL_SECONDS", 15),
    "idle_seconds": _env_int("CODE_IDLE_SECONDS", 60),         # no output and no input
    "compile_seconds": _env_int("CODE_COMPILE_SECONDS", 20),
    "memory_mb": _env_int("CODE_MEMORY_MB", 256),
    # Address space, not RAM: numpy/pandas/matplotlib reserve far more than they touch.
    "python_memory_mb": _env_int("CODE_PY_MEMORY_MB", 1024),
    "compile_memory_mb": _env_int("CODE_COMPILE_MEMORY_MB", 1024),
    "file_size_mb": _env_int("CODE_FILE_SIZE_MB", 2),
    "output_bytes": _env_int("CODE_OUTPUT_BYTES", 100_000),
    "stdin_bytes": _env_int("CODE_STDIN_BYTES", 64_000),
    "max_files": 20,
    "max_source_bytes": 400_000,
    "nproc": _env_int("CODE_NPROC", 512),                      # total processes for SANDBOX_UID
    "display_images": 20,                                      # pictures shown per run
    "display_bytes": 1_000_000,                                # one picture, base64
    # pip
    "pip_concurrent": _env_int("CODE_PIP_CONCURRENT", 3),      # installs at once (downloads + unpacking)
    "pip_seconds": _env_int("CODE_PIP_SECONDS", 240),
    "pkg_quota_mb": _env_int("CODE_PKG_QUOTA_MB", 400),        # per session
    "pkg_total_mb": _env_int("CODE_PKG_TOTAL_MB", 20_000),     # all sessions together
    "pkg_ttl_hours": _env_int("CODE_PKG_TTL_HOURS", 12),
}
SANDBOX_UID = _env_int("SANDBOX_UID", 0)
SANDBOX_GID = _env_int("SANDBOX_GID", SANDBOX_UID)
SHIM_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sandbox_shims")
PKG_ROOT = os.getenv("SANDBOX_PKG_DIR") or os.path.join(tempfile.gettempdir(), "sandbox_pkgs")
MPL_CACHE = os.getenv("SANDBOX_MPL_CACHE", "")  # prebuilt matplotlib font cache (see Dockerfile)
_IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
                ".svg": "image/svg+xml"}
_DISPLAY_MIMES = set(_IMAGE_TYPES.values())
# One BLAS/OpenMP thread per program: many threads per run would exhaust the sandbox user's process limit.
_PY_ENV = {"OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
           "NUMEXPR_MAX_THREADS": "1", "MPLBACKEND": "module://_sandbox_mpl"}

LANG_EXT = {
    "python": (".py",),
    "c": (".c", ".h"),
    "cpp": (".cpp", ".cc", ".cxx", ".hpp", ".h"),
    "java": (".java",),
}
# The JVM reserves far more address space than it uses, so Java gets a heap cap instead of RLIMIT_AS.
_JAVA_OPTS = ["-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-XX:CICompilerCount=1", "-Xss8m",
              "-XX:MaxMetaspaceSize=128m", "-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8"]
_JAVA_MAIN_RE = re.compile(r"public\s+static\s+(?:final\s+)?void\s+main\s*\(")
_FILENAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$")

Emit = Callable[[Dict[str, Any]], Awaitable[None]]


class RunRejected(Exception):
    """The run was refused before starting (busy, rate limited, invalid input)."""


# ─── Python sandbox bootstrap (runs inside the student process) ──────────────

_PY_BOOT = r'''
import os, sys

_WORK = os.path.realpath(sys.argv[1])
_ENTRY = os.path.join(_WORK, sys.argv[2])
_SHIM = os.path.realpath(sys.argv[3])
_READ_ROOTS = tuple({os.path.realpath(p) for p in (sys.prefix, sys.base_prefix, sys.exec_prefix,
                    sys.base_exec_prefix, _SHIM, "/usr/share/zoneinfo", "/usr/share/fonts",
                    "/dev/null", "/dev/urandom")})
_BLOCKED = ("os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty",
            "subprocess.", "pty.", "socket.", "ctypes.", "os.kill", "os.killpg",
            "signal.pthread_kill", "os.setuid", "os.setgid", "resource.setrlimit", "_posixsubprocess.")
_PATH_EVENTS = {"os.remove", "os.rmdir", "os.mkdir", "os.rename", "os.replace", "os.truncate",
                "os.chmod", "os.chown", "os.link", "os.symlink", "os.utime", "shutil.rmtree",
                "shutil.copyfile", "shutil.move", "os.chdir"}

def _inside(path, roots):
    try:
        p = os.path.realpath(os.fsdecode(path) if not isinstance(path, int) else "")
    except Exception:
        return False
    return any(p == r or p.startswith(r + os.sep) for r in roots)

def _deny(what):
    raise PermissionError(what + " is not allowed in this environment")

def _hook(event, args):
    if event == "ctypes.dlopen" and args and args[0] is None:
        return  # `import ctypes` itself (numpy needs it); looking up any function (ctypes.dlsym) stays blocked
    if event.startswith(_BLOCKED):
        _deny(event.split(".")[0] if event.startswith(("socket.", "subprocess.", "ctypes.")) else event)
    if event == "open":
        path, mode, flags = (list(args) + [None, None, None])[:3]
        if isinstance(path, int):
            return
        writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
            isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC))
        if not (_inside(path, (_WORK,)) or (not writing and _inside(path, _READ_ROOTS))):
            _deny("Access to " + os.fsdecode(path))
    elif event in ("os.listdir", "os.scandir"):
        if args and args[0] is not None and not _inside(args[0], (_WORK,) + _READ_ROOTS):
            _deny("Listing " + os.fsdecode(args[0]))
    elif event in _PATH_EVENTS:
        for a in args[:2]:
            if isinstance(a, (str, bytes, os.PathLike)) and not _inside(a, (_WORK,)):
                _deny(event + " outside your project folder")

sys.addaudithook(_hook)
sys.path.insert(0, _WORK)
sys.path.insert(0, _SHIM)  # browser versions of turtle and the matplotlib backend

import atexit, signal, _sandbox_display
atexit.register(_sandbox_display.finish)

def _on_cpu_limit(signum, frame):
    # Show what was drawn so far, then let the CPU limit stop the program as usual.
    signal.signal(signal.SIGXCPU, signal.SIG_DFL)
    _sandbox_display.finish()
    signal.raise_signal(signal.SIGXCPU)

signal.signal(signal.SIGXCPU, _on_cpu_limit)

import runpy, traceback
try:
    runpy.run_path(_ENTRY, run_name="__main__")
except SystemExit:
    raise
except BaseException as exc:
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename.startswith(_WORK)]
    for f in frames:
        f.filename = os.path.relpath(f.filename, _WORK)
    sys.stderr.write("Traceback (most recent call last):\n" if frames else "")
    sys.stderr.write("".join(traceback.format_list(frames)))
    sys.stderr.write("".join(traceback.format_exception_only(type(exc), exc)))
    sys.exit(1)
'''

# Makes C stdout unbuffered so prompts like printf("Name: ") appear before scanf waits.
_C_INIT = "#include <stdio.h>\n__attribute__((constructor)) static void _sandbox_unbuffer(void) " \
          "{ setvbuf(stdout, NULL, _IONBF, 0); }\n"


# ─── Admission control ───────────────────────────────────────────────────────

_slots = asyncio.Semaphore(LIMITS["max_concurrent"])
_active: Dict[str, "Run"] = {}
_recent: Dict[str, Deque[float]] = collections.defaultdict(collections.deque)
stats = {"started": 0, "rejected_busy": 0, "rejected_rate": 0, "running": 0}


def _check_rate(key: str) -> None:
    now = time.monotonic()
    q = _recent[key]
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= LIMITS["runs_per_minute"]:
        stats["rejected_rate"] += 1
        raise RunRejected(
            f"You're running code too often (max {LIMITS['runs_per_minute']} runs per minute). "
            "Please wait a few seconds and try again."
        )
    q.append(now)
    if len(_recent) > 5000:  # forget idle sessions
        for k in [k for k, v in _recent.items() if not v or now - v[-1] > 60]:
            del _recent[k]


def clean_files(language: str, files: List[Dict[str, str]], entry: Optional[str]) -> Tuple[List[Dict[str, str]], str]:
    if language not in LANG_EXT:
        raise RunRejected(f"Running {language} on the server is not supported.")
    if not files:
        raise RunRejected("No code to run.")
    if len(files) > LIMITS["max_files"]:
        raise RunRejected(f"Too many files (max {LIMITS['max_files']}).")
    out, total = [], 0
    for f in files:
        name = os.path.basename(str(f.get("filename") or ""))
        if not _FILENAME_RE.match(name):
            raise RunRejected(f"Invalid file name: {name or '(empty)'}")
        content = str(f.get("content") or "")
        total += len(content.encode("utf-8", "replace"))
        out.append({"filename": name, "content": content})
    if total > LIMITS["max_source_bytes"]:
        raise RunRejected("Your code is too large to run.")
    names = [f["filename"] for f in out]
    if entry not in names:
        entry = next((n for n in names if n.endswith(LANG_EXT[language][0])), names[0])
    if language == "python" and not entry.endswith(".py"):
        raise RunRejected("The file to run must be a .py file.")
    if language == "java":
        java = [f for f in out if f["filename"].endswith(".java")]
        if not entry.endswith(".java") or not _JAVA_MAIN_RE.search(next(f["content"] for f in out if f["filename"] == entry)):
            entry = next((f["filename"] for f in java if _JAVA_MAIN_RE.search(f["content"])), entry)
    return out, entry


# ─── Packages (pip) ──────────────────────────────────────────────────────────

# A requirement: name, optional extras, optional version specifiers ("pandas", "requests[socks]>=2,<3").
_REQ_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]{1,100}\])?"
                     r"(?:(?:===|==|!=|~=|<=|>=|<|>)[A-Za-z0-9.*+!_-]{1,40}"
                     r"(?:,(?:===|==|!=|~=|<=|>=|<|>)[A-Za-z0-9.*+!_-]{1,40}){0,5})?$")
_PIP_INSTALL_FLAGS = {"-U": "--upgrade", "--upgrade": "--upgrade", "--pre": "--pre", "--no-deps": "--no-deps",
                      "-q": "--quiet", "--quiet": "--quiet", "--force-reinstall": "--force-reinstall"}
_pip_slots: Optional[asyncio.Semaphore] = None
_last_sweep = 0.0


def _pkg_env(key: str) -> str:
    return os.path.join(PKG_ROOT, "envs", hashlib.sha256(key.encode("utf-8")).hexdigest()[:24])


def package_python(key: str) -> Optional[str]:
    """The Python of this session's package environment, if it installed anything."""
    py = os.path.join(_pkg_env(key), "bin", "python")
    if not os.path.exists(py):
        return None
    try:
        os.utime(_pkg_env(key))  # keeps it alive for the TTL sweep
    except OSError:
        pass
    return py


def _dir_mb(path: str) -> float:
    total = 0
    for d, _dirs, names in os.walk(path):
        for n in names:
            try:
                total += os.lstat(os.path.join(d, n)).st_size
            except OSError:
                pass
    return total / (1 << 20)


def clear_packages(key: str) -> bool:
    """Delete a session's installed packages (called when the student submits)."""
    env = _pkg_env(key)
    if not os.path.isdir(env):
        return False
    shutil.rmtree(env, ignore_errors=True)
    logging.getLogger(__name__).info("Removed packages for session %s…", key[:8])
    return True


def sweep_packages() -> int:
    """Delete package environments unused for pkg_ttl_hours (sessions that never submitted)."""
    global _last_sweep
    _last_sweep = time.time()
    root = os.path.join(PKG_ROOT, "envs")
    cutoff = time.time() - LIMITS["pkg_ttl_hours"] * 3600
    removed = 0
    try:
        entries = list(os.scandir(root))
    except OSError:
        return 0
    for e in entries:
        try:
            if e.is_dir(follow_symlinks=False) and e.stat().st_mtime < cutoff:
                shutil.rmtree(e.path, ignore_errors=True)
                removed += 1
        except OSError:
            pass
    return removed


def _parse_pip(args: List[str], files: List[Dict[str, str]]) -> Tuple[str, List[str]]:
    """Validate a `pip ...` command line. Returns (subcommand, pip arguments) or raises RunRejected."""
    if not args or args[0] in ("-h", "--help", "help"):
        raise RunRejected("Usage: pip install <package> [<package> ...]   ·   pip list   ·   pip show <package>   ·   "
                          "pip uninstall <package>   ·   pip install -r requirements.txt")
    sub, rest = args[0], args[1:]
    if sub in ("--version", "-V"):
        return "version", []
    if sub in ("list", "freeze"):
        return sub, []
    if sub not in ("install", "uninstall", "show"):
        raise RunRejected(f"pip {sub} is not available here. Try: pip install <package>")
    reqs: List[str] = []
    flags: List[str] = []
    i = 0
    while i < len(rest):
        a = rest[i]
        if sub == "install" and a in ("-r", "--requirement"):
            if i + 1 >= len(rest):
                raise RunRejected("pip install -r needs a file name, e.g. pip install -r requirements.txt")
            name = rest[i + 1]
            content = next((f.get("content") for f in files if f.get("filename") == name), None)
            if content is None:
                raise RunRejected(f"Could not open requirements file: {name}")
            for line in str(content).splitlines():
                line = line.split("#", 1)[0].strip()
                if line:
                    reqs.append(line.replace(" ", ""))
            i += 2
            continue
        if sub == "install" and a in _PIP_INSTALL_FLAGS:
            flags.append(_PIP_INSTALL_FLAGS[a])
        elif sub == "uninstall" and a in ("-y", "--yes"):
            pass
        elif a.startswith("-"):
            raise RunRejected(f"The pip option {a} is not available here.")
        else:
            reqs.append(a)
        i += 1
    if not reqs:
        raise RunRejected(f"Usage: pip {sub} <package>")
    if len(reqs) > 15:
        raise RunRejected("Please install at most 15 packages at a time.")
    for r in reqs:
        if not _REQ_RE.match(r):
            raise RunRejected(f"'{r}' is not a package name pip can install here "
                              "(packages come from PyPI by name, e.g. pip install requests).")
    if sub == "uninstall":
        flags.append("-y")
    return sub, flags + reqs


async def run_pip(*, key: str, args: List[str], files: List[Dict[str, str]], emit: Emit) -> Dict[str, Any]:
    """`pip install/uninstall/list/show/freeze` in the session's own package environment."""
    global _pip_slots
    sub, pip_args = _parse_pip([str(a) for a in (args or [])][:40], files or [])
    _check_rate(key)
    env_dir = _pkg_env(key)
    env_py = os.path.join(env_dir, "bin", "python")
    has_env = os.path.exists(env_py)
    tail: List[str] = []  # end of pip's output, to explain common failures

    async def emit_and_keep(ev: Dict[str, Any]) -> None:
        if ev.get("type") == "output":
            tail.append(ev["data"])
            del tail[:-20]
        await emit(ev)

    run = Run(key, emit_and_keep, None)
    previous = _active.get(key)
    if previous:
        previous.kill("replaced")
    _active[key] = run
    pip_env = {"HOME": os.path.join(PKG_ROOT, "home"), "PIP_DISABLE_PIP_VERSION_CHECK": "1",
               "PIP_NO_INPUT": "1", "PIP_ROOT_USER_ACTION": "ignore", "PIP_PROGRESS_BAR": "off",
               "PYTHONIOENCODING": "utf-8"}
    try:
        if sub in ("version", "list", "freeze", "show") or (sub == "uninstall" and not has_env):
            if sub == "uninstall":
                raise RunRejected("You have not installed any packages yet (preinstalled ones cannot be removed).")
            py = env_py if has_env else sys.executable
            argv = [py, "-m", "pip"] + (["--version"] if sub == "version" else [sub] + pip_args)
            os.makedirs(pip_env["HOME"], exist_ok=True)
            res = await run.execute(argv, PKG_ROOT, memory_mb=LIMITS["compile_memory_mb"], cpu=30, wall=60,
                                    interactive=False, env=pip_env)
        else:
            if _pip_slots is None:
                _pip_slots = asyncio.Semaphore(LIMITS["pip_concurrent"])
            if time.time() - _last_sweep > 3600:
                await asyncio.to_thread(sweep_packages)
            if _pip_slots.locked():
                await emit({"type": "output", "stream": "stdout", "data": "Waiting for other installs to finish…\n"})
            try:
                await asyncio.wait_for(_pip_slots.acquire(), timeout=LIMITS["pip_seconds"])
            except asyncio.TimeoutError:
                raise RunRejected("The server is busy installing packages for other students. Please try again in a minute.")
            try:
                if sub == "install" and await asyncio.to_thread(_dir_mb, os.path.join(PKG_ROOT, "envs")) > LIMITS["pkg_total_mb"]:
                    raise RunRejected("The server has no room for more packages right now. Please ask your instructor.")
                for d in ("envs", "cache", "tmp", "home"):
                    os.makedirs(os.path.join(PKG_ROOT, d), exist_ok=True)
                if not has_env:
                    # Sees the preinstalled packages (numpy, pandas, matplotlib…), so pip only adds what is new.
                    proc = await asyncio.create_subprocess_exec(
                        sys.executable, "-m", "venv", "--without-pip", "--system-site-packages", env_dir,
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
                    _, err = await proc.communicate()
                    if proc.returncode != 0:
                        raise RunRejected("Could not prepare a package folder: " + err.decode(errors="replace")[-300:])
                tmp = tempfile.mkdtemp(prefix="pip_", dir=os.path.join(PKG_ROOT, "tmp"))
                pip_env.update({"TMPDIR": tmp, "PIP_CACHE_DIR": os.path.join(PKG_ROOT, "cache")})
                for name in ("PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "PIP_TRUSTED_HOST"):
                    if os.getenv(name):
                        pip_env[name] = os.environ[name]
                argv = [env_py, "-m", "pip", sub]
                if sub == "install":
                    # Wheels only: installing a wheel runs no code from the package.
                    argv += ["--only-binary=:all:", "--no-warn-script-location", "--upgrade-strategy", "only-if-needed"]
                await emit({"type": "status", "phase": "running"})
                try:
                    # pip itself is trusted; it runs as the runner user so student programs (SANDBOX_UID)
                    # can read the packages but never change them.
                    res = await run.execute(argv + pip_args, env_dir, memory_mb=LIMITS["compile_memory_mb"] * 2,
                                            cpu=LIMITS["pip_seconds"], wall=LIMITS["pip_seconds"], interactive=False,
                                            env=pip_env, fsize_mb=1024, drop_privileges=False, umask=0o022)
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)
                if sub == "install":
                    size = await asyncio.to_thread(_dir_mb, env_dir)
                    if size > LIMITS["pkg_quota_mb"]:
                        shutil.rmtree(env_dir, ignore_errors=True)
                        await emit({"type": "output", "stream": "stderr", "data":
                                    f"\nThese packages need {size:.0f} MB, more than the {LIMITS['pkg_quota_mb']} MB "
                                    "allowed per student, so they were removed. Try installing fewer packages.\n"})
                        res["exit_code"] = 1
                    elif res.get("exit_code") == 0:
                        await emit({"type": "output", "stream": "stdout", "data":
                                    "\nThese packages are only for you, and are removed when you submit.\n"})
                    elif "from versions: none" in "".join(tail):
                        await emit({"type": "output", "stream": "stderr", "data":
                                    "\nThis package has no ready-made version (wheel) for this server, or the name is "
                                    "misspelled. Packages that must be compiled from source cannot be installed here.\n"})
            finally:
                _pip_slots.release()
    finally:
        if _active.get(key) is run:
            del _active[key]
    res["reason"] = run.reason
    res["message"] = reason_text(run.reason, LIMITS["pip_seconds"]) if run.reason else ""
    return res


# ─── A single run ────────────────────────────────────────────────────────────

def _preexec(memory_mb: int, cpu_seconds: int, *, fsize_mb: Optional[int] = None,
             drop_privileges: bool = True, umask: int = 0o077) -> Callable[[], None]:
    fsize = (fsize_mb if fsize_mb is not None else LIMITS["file_size_mb"]) << 20
    drop = drop_privileges and bool(SANDBOX_UID)

    def apply() -> None:
        os.umask(umask)
        try:  # under memory pressure, Linux kills student programs before the runner itself
            with open("/proc/self/oom_score_adj", "w") as fh:
                fh.write("1000")
        except OSError:
            pass
        if resource is not None:
            limits = [
                (resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1)),
                (resource.RLIMIT_FSIZE, (fsize,) * 2),
                (resource.RLIMIT_NOFILE, (256, 256)),
                (resource.RLIMIT_CORE, (0, 0)),
            ]
            if memory_mb > 0:  # 0 = the program caps its own memory (the JVM's -Xmx)
                limits.append((getattr(resource, "RLIMIT_AS", None), (memory_mb << 20,) * 2))
            if drop and os.geteuid() == 0:
                limits.append((resource.RLIMIT_NPROC, (LIMITS["nproc"],) * 2))
            for which, value in limits:
                if which is None:
                    continue
                try:
                    resource.setrlimit(which, value)
                except (ValueError, OSError):
                    pass  # e.g. RLIMIT_AS is not enforceable on macOS
        if drop and os.geteuid() == 0:
            os.setgroups([])
            os.setgid(SANDBOX_GID)
            os.setuid(SANDBOX_UID)
    return apply


class Run:
    def __init__(self, key: str, emit: Emit, stdin: Optional["asyncio.Queue[Optional[str]]"]):
        self.key = key
        self.emit = emit
        self.stdin = stdin
        self.interactive = False
        self.wall = 0
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.reason = ""          # why we stopped it: timeout | idle | output_limit | cpu | memory | stopped
        self.out_bytes = 0
        self.in_bytes = 0
        self.images = 0           # pictures shown (display events)
        self.display = False
        self.last_activity = time.monotonic()
        self.stopped = asyncio.Event()

    def kill(self, reason: str) -> None:
        if not self.reason:
            self.reason = reason
        self.stopped.set()
        if self.proc and self.proc.returncode is None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                try:
                    self.proc.kill()
                except ProcessLookupError:
                    pass

    async def _pump(self, stream: asyncio.StreamReader, name: str) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        while True:
            chunk = await stream.read(4096)
            if not chunk:
                break
            self.last_activity = time.monotonic()
            room = LIMITS["output_bytes"] - self.out_bytes
            self.out_bytes += len(chunk)
            if room <= 0:
                self.kill("output_limit")
                break
            text = decoder.decode(chunk[:room])
            if text:
                await self.emit({"type": "output", "stream": name, "data": text})
            if len(chunk) > room:
                self.kill("output_limit")
                break

    async def _display(self, fd: int) -> None:
        """Forward pictures the program sends on its display pipe (see sandbox_shims/_sandbox_display.py)."""
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=LIMITS["display_bytes"] + 4096)
        transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), os.fdopen(fd, "rb", 0))
        try:
            while True:
                try:
                    line = await reader.readline()
                except (ValueError, asyncio.LimitOverrunError):
                    break  # oversized message: stop listening (the program's next send fails quietly)
                if not line:
                    break
                try:
                    msg = json.loads(line)
                    mime, data = str(msg.get("mime")), str(msg.get("data") or "")
                except (ValueError, AttributeError):
                    continue
                if mime not in _DISPLAY_MIMES or not data or self.images >= LIMITS["display_images"]:
                    continue
                self.images += 1
                self.last_activity = time.monotonic()
                await self.emit({"type": "display", "mime": mime, "name": str(msg.get("name") or "")[:80], "data": data})
        finally:
            transport.close()

    async def _feed(self) -> None:
        assert self.proc and self.proc.stdin
        if self.stdin is None or not self.interactive:
            self.proc.stdin.close()
            return
        while True:
            line = await self.stdin.get()
            if line is None:  # EOF (Ctrl+D) or client gone
                self.proc.stdin.close()
                return
            self.in_bytes += len(line)
            if self.in_bytes > LIMITS["stdin_bytes"]:
                self.kill("input_limit")
                return
            self.last_activity = time.monotonic()
            try:
                self.proc.stdin.write(line.encode("utf-8", "replace"))
                await self.proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                return

    async def _stop_showing(self, reason: str) -> None:
        """Stop a program, first letting a Python program show its pictures (its SIGXCPU handler)."""
        if self.display and self.proc and self.proc.returncode is None:
            self.reason = self.reason or reason
            try:
                os.kill(self.proc.pid, signal.SIGXCPU)
                await asyncio.wait_for(self.proc.wait(), timeout=2)
            except (ProcessLookupError, PermissionError, asyncio.TimeoutError):
                pass
        self.kill(reason)

    async def _watchdog(self, started: float) -> None:
        while self.proc and self.proc.returncode is None:
            await asyncio.sleep(0.5)
            now = time.monotonic()
            if now - started > self.wall:
                await self._stop_showing("timeout")
            elif self.interactive and now - self.last_activity > LIMITS["idle_seconds"]:
                await self._stop_showing("idle")

    async def execute(
        self, argv: List[str], cwd: str, *, memory_mb: int, cpu: int, wall: int, interactive: bool,
        env: Optional[Dict[str, str]] = None, display: bool = False, fsize_mb: Optional[int] = None,
        drop_privileges: bool = True, umask: int = 0o077,
    ) -> Dict[str, Any]:
        self.wall, self.interactive, self.display = wall, interactive, display
        started = self.last_activity = time.monotonic()
        full_env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": cwd, "PYTHONIOENCODING": "utf-8"}
        full_env.update(env or {})
        rfd = wfd = -1
        if display:
            rfd, wfd = os.pipe()
            full_env["SANDBOX_DISPLAY_FD"] = str(wfd)
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *argv, cwd=cwd,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=full_env, pass_fds=(wfd,) if display else (), start_new_session=True,
                preexec_fn=_preexec(memory_mb, cpu, fsize_mb=fsize_mb, drop_privileges=drop_privileges, umask=umask),
            )
        except BaseException:
            if display:
                os.close(rfd)
            raise
        finally:
            if display:
                os.close(wfd)  # the program holds the only write end now, so EOF means it exited
        assert self.proc.stdout and self.proc.stderr
        tasks = [
            asyncio.create_task(self._pump(self.proc.stdout, "stdout")),
            asyncio.create_task(self._pump(self.proc.stderr, "stderr")),
        ]
        if display:
            tasks.append(asyncio.create_task(self._display(rfd)))
        helpers = [asyncio.create_task(self._feed()), asyncio.create_task(self._watchdog(started))]
        try:
            await asyncio.gather(*tasks)
            await self.proc.wait()
        finally:
            for t in helpers:
                t.cancel()
            if self.proc.returncode is None:
                self.kill(self.reason or "stopped")
                await self.proc.wait()
        code = self.proc.returncode
        if not self.reason and code is not None and code < 0:
            sig = -code
            self.reason = {signal.SIGXCPU: "cpu", signal.SIGKILL: "cpu", signal.SIGSEGV: "crash",
                           signal.SIGXFSZ: "file_size"}.get(sig, "signal")
        return {"exit_code": code, "duration_ms": int((time.monotonic() - started) * 1000)}


_REASON_TEXT = {
    "timeout": "Stopped: the program ran longer than {wall} seconds.",
    "idle": "Stopped: no output or input for {idle} seconds.",
    "output_limit": "Stopped: the program printed too much output (limit {out_kb} KB).",
    "input_limit": "Stopped: too much input was sent to the program.",
    "cpu": "Stopped: the program used more than {cpu} seconds of CPU time (infinite loop?).",
    "file_size": "Stopped: the program tried to write a file larger than {fs} MB.",
    "crash": "The program crashed (segmentation fault).",
    "stopped": "Stopped.",
    "replaced": "Stopped because a new run was started.",
}


def reason_text(reason: str, wall: int) -> str:
    return _REASON_TEXT.get(reason, "").format(
        wall=wall, idle=LIMITS["idle_seconds"], out_kb=LIMITS["output_bytes"] // 1000,
        cpu=LIMITS["cpu_seconds"], fs=LIMITS["file_size_mb"],
    )


async def _show_saved_images(run: "Run", work: str, own_files: set) -> None:
    """Images the program wrote (e.g. plt.savefig("chart.png")) are shown, since the run folder is deleted."""
    try:
        names = sorted(n for n in os.listdir(work)
                       if not n.startswith(".") and n not in own_files and os.path.splitext(n)[1].lower() in _IMAGE_TYPES)
    except OSError:
        return
    for name in names[:5]:
        path = os.path.join(work, name)
        try:
            if os.path.islink(path) or not os.path.isfile(path) or os.path.getsize(path) > 700_000:
                continue
            with open(path, "rb") as fh:
                data = base64.b64encode(fh.read()).decode("ascii")
        except OSError:
            continue
        run.images += 1
        await run.emit({"type": "display", "mime": _IMAGE_TYPES[os.path.splitext(name)[1].lower()], "name": name, "data": data})


async def run_code(
    *,
    key: str,
    language: str,
    files: List[Dict[str, str]],
    entry: Optional[str],
    emit: Emit,
    stdin: Optional["asyncio.Queue[Optional[str]]"] = None,
    compile_only: bool = False,
    batch: bool = False,
) -> Dict[str, Any]:
    """Run a program, streaming events through `emit`. `stdin=None` means non-interactive (EOF).
    `compile_only` (C, C++, Java) stops after compiling, like running `gcc` in a terminal.

    Raises RunRejected before starting if the request is invalid or the server is busy.
    """
    language = (language or "").lower()
    files, entry = clean_files(language, files, entry)
    _check_rate(key)
    wall = LIMITS["batch_wall_seconds"] if batch or stdin is None else LIMITS["wall_seconds"]

    run = Run(key, emit, stdin)
    previous = _active.get(key)
    if previous:
        previous.kill("replaced")
    _active[key] = run

    if _slots.locked():
        await emit({"type": "status", "phase": "queued"})
    try:
        await asyncio.wait_for(_slots.acquire(), timeout=LIMITS["queue_seconds"])
    except asyncio.TimeoutError:
        stats["rejected_busy"] += 1
        if _active.get(key) is run:
            del _active[key]
        raise RunRejected("The server is busy running other students' code. Please try again in a moment.")

    stats["started"] += 1
    stats["running"] += 1
    root = tempfile.mkdtemp(prefix="run_")
    work = os.path.join(root, "work")
    result: Dict[str, Any] = {"exit_code": None, "duration_ms": 0}
    try:
        if run.stopped.is_set():  # replaced while queued
            return {"exit_code": None, "duration_ms": 0, "reason": run.reason, "message": reason_text(run.reason, wall)}
        os.mkdir(work)
        for f in files:
            with open(os.path.join(work, f["filename"]), "w", encoding="utf-8") as fh:
                fh.write(f["content"])
        mpl_dir = os.path.join(work, ".matplotlib")
        if language == "python":
            os.mkdir(mpl_dir)
            if MPL_CACHE and os.path.isdir(MPL_CACHE):  # skips rebuilding the font list on every run
                for name in os.listdir(MPL_CACHE):
                    if name.endswith(".json"):
                        shutil.copy(os.path.join(MPL_CACHE, name), mpl_dir)
        if SANDBOX_UID and os.geteuid() == 0:
            for d, _dirs, fnames in os.walk(root):
                os.chown(d, SANDBOX_UID, SANDBOX_GID)
                for n in fnames:
                    os.chown(os.path.join(d, n), SANDBOX_UID, SANDBOX_GID)
            os.chmod(root, 0o700)

        if language == "python":
            boot = os.path.join(root, "boot.py")
            with open(boot, "w", encoding="utf-8") as fh:
                fh.write(_PY_BOOT)
            if SANDBOX_UID and os.geteuid() == 0:
                os.chown(boot, SANDBOX_UID, SANDBOX_GID)
            python = package_python(key) or sys.executable
            argv = [python, "-I", "-u", "-X", "utf8", boot, work, entry, SHIM_DIR]
            await emit({"type": "status", "phase": "running"})
            result = await run.execute(argv, work, memory_mb=LIMITS["python_memory_mb"], cpu=LIMITS["cpu_seconds"],
                                       wall=wall, interactive=stdin is not None,
                                       env=dict(_PY_ENV, MPLCONFIGDIR=mpl_dir), display=True)
        elif language == "java":
            await emit({"type": "status", "phase": "compiling"})
            sources = [f["filename"] for f in files if f["filename"].endswith(".java")]
            mb = LIMITS["compile_memory_mb"]
            cres = await run.execute(
                ["javac", f"-J-Xmx{mb // 2}m", "-J-XX:+UseSerialGC", "-J-XX:TieredStopAtLevel=1",
                 "-encoding", "UTF-8", "-Xlint:none", "-d", "../classes", *sources],
                work, memory_mb=0, cpu=LIMITS["compile_seconds"], wall=LIMITS["compile_seconds"], interactive=False,
            )
            main_class = entry[:-5]
            if run.reason or cres["exit_code"] != 0:
                result = {**cres, "compile_error": True}
            elif compile_only:
                result = {**cres, "compiled": True}
            else:
                await emit({"type": "status", "phase": "running"})
                result = await run.execute(
                    ["java", f"-Xmx{LIMITS['memory_mb']}m", *_JAVA_OPTS, "-cp", "../classes", main_class],
                    work, memory_mb=0, cpu=LIMITS["cpu_seconds"], wall=wall, interactive=stdin is not None,
                )
        else:  # c / cpp
            await emit({"type": "status", "phase": "compiling"})
            init = "sandbox_init.cpp" if language == "cpp" else "sandbox_init.c"
            with open(os.path.join(root, init), "w") as fh:
                fh.write(_C_INIT)
            exe = os.path.join(root, "program")
            if language == "cpp":
                sources = [f["filename"] for f in files if f["filename"].endswith((".cpp", ".cc", ".cxx"))]
                compiler = ["g++", "-std=gnu++17"]
            else:
                sources = [f["filename"] for f in files if f["filename"].endswith(".c")]
                compiler = ["gcc", "-std=gnu11"]
            # Relative paths so compiler errors read "main.c:3:5: error: ...".
            cres = await run.execute(
                [*compiler, "-O0", "-Wall", "-o", "../program", *sources, "../" + init, "-lm"],
                work, memory_mb=LIMITS["compile_memory_mb"], cpu=LIMITS["compile_seconds"],
                wall=LIMITS["compile_seconds"], interactive=False,
            )
            if run.reason or cres["exit_code"] != 0 or not os.path.exists(exe):
                result = {**cres, "compile_error": True}
            elif compile_only:
                result = {**cres, "compiled": True}
            else:
                await emit({"type": "status", "phase": "running"})
                result = await run.execute([exe], work, memory_mb=LIMITS["memory_mb"], cpu=LIMITS["cpu_seconds"],
                                           wall=wall, interactive=stdin is not None)
        if not compile_only and not result.get("compile_error") and run.images == 0:
            await _show_saved_images(run, work, {f["filename"] for f in files})
    finally:
        stats["running"] -= 1
        _slots.release()
        if _active.get(key) is run:
            del _active[key]
        shutil.rmtree(root, ignore_errors=True)

    result["reason"] = run.reason
    result["message"] = reason_text(run.reason, wall) if run.reason else ""
    return result


def stop(key: str) -> None:
    run = _active.get(key)
    if run:
        run.kill("stopped")


async def run_batch(
    *, key: str, language: str, files: List[Dict[str, str]], entry: Optional[str], stdin: Optional[str] = None
) -> Dict[str, Any]:
    """Non-interactive run that collects output (used by the agent's run_code tool and /execute).
    `stdin` text, if given, is fed to the program followed by end-of-input."""
    out: List[str] = []
    err: List[str] = []

    async def collect(ev: Dict[str, Any]) -> None:
        if ev["type"] == "output":
            (out if ev["stream"] == "stdout" else err).append(ev["data"])

    started = time.monotonic()
    try:
        queue: Optional["asyncio.Queue[Optional[str]]"] = None
        if stdin:
            queue = asyncio.Queue()
            queue.put_nowait(stdin[: LIMITS["stdin_bytes"]])
            queue.put_nowait(None)
        res = await run_code(key=key, language=language, files=files, entry=entry, emit=collect, stdin=queue, batch=True)
    except RunRejected as e:
        return {"success": False, "output": "", "error": str(e), "execution_time": 0.0}
    error = "".join(err)
    if res.get("message"):
        error = (error + "\n" + res["message"]).strip()
    return {
        "success": res.get("exit_code") == 0 and not res.get("reason"),
        "output": "".join(out),
        "error": error,
        "execution_time": time.monotonic() - started,
    }


async def serve_websocket(ws: Any, start: Optional[Dict[str, Any]] = None) -> None:
    """Drive one interactive run over an accepted Starlette WebSocket (see runner.py for the protocol)."""
    from starlette.websockets import WebSocketDisconnect
    if start is None:
        try:
            start = await asyncio.wait_for(ws.receive_json(), timeout=10)
        except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
            await ws.close()
            return
    key = str(start.get("key") or "")
    stdin: "asyncio.Queue[Optional[str]]" = asyncio.Queue()
    closed = False

    async def emit(ev: Dict[str, Any]) -> None:
        if not closed:
            try:
                await ws.send_json(ev)
            except Exception:
                pass

    async def read_client() -> None:
        nonlocal closed
        try:
            while True:
                msg = await ws.receive_json()
                t = msg.get("type")
                if t == "stdin":
                    await stdin.put(str(msg.get("data", ""))[:4000])
                elif t == "eof":
                    await stdin.put(None)
                elif t == "stop":
                    stop(key)
        except (WebSocketDisconnect, RuntimeError, ValueError):
            closed = True
            stop(key)
            await stdin.put(None)

    reader = asyncio.create_task(read_client())
    try:
        if start.get("action") == "pip":
            result = await run_pip(key=key, args=list(start.get("args") or []), files=list(start.get("files") or []),
                                   emit=emit)
        else:
            result = await run_code(
                key=key, language=str(start.get("language") or ""), files=list(start.get("files") or []),
                entry=start.get("entry"), emit=emit, stdin=stdin, compile_only=bool(start.get("compile_only")),
            )
        await emit({"type": "exit", **result})
    except RunRejected as e:
        await emit({"type": "rejected", "message": str(e)})
    except Exception as e:  # never leave the client hanging
        logging.getLogger(__name__).exception("run failed")
        await emit({"type": "rejected", "message": f"Could not run the program: {e}"})
    finally:
        reader.cancel()
        if not closed:
            try:
                await ws.close()
            except Exception:
                pass
