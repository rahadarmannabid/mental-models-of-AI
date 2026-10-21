"""Small helpers for Firebase Realtime Database typing (Pyright-safe)."""

from typing import Any, Dict, Optional


def fb_dict(val: object) -> Optional[Dict[str, Any]]:
    """Coerce RTDB .get() result to dict; None or non-dict snapshots become None."""
    if isinstance(val, dict):
        return val
    return None


# ─── Per-worker quiz-data cache ──────────────────────────────────────────────
# Students joining a quiz at once all read the same quiz_access/{code} and quizzes/{id}
# nodes. Cache them briefly per worker; one thread fetches each key while the rest wait.
# Instructor writes invalidate this worker's copy; other workers see changes within the TTL.

import copy as _copy
import threading as _threading
import time as _time
from typing import Callable, Tuple

QUIZ_CACHE_TTL_SECONDS = 30.0

_quiz_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_quiz_cache_lock = _threading.Lock()
_quiz_fetch_locks: Dict[str, _threading.Lock] = {}


def _cached_fetch(key: str, fetch: Callable[[], object]) -> Optional[Dict[str, Any]]:
    """Return a deep copy of the cached dict for key, fetching it on a miss. Misses are not cached."""
    def fresh() -> Optional[Dict[str, Any]]:
        hit = _quiz_cache.get(key)
        if hit and _time.monotonic() - hit[0] < QUIZ_CACHE_TTL_SECONDS:
            return hit[1]
        return None

    val = fresh()
    if val is None:
        with _quiz_cache_lock:
            fetch_lock = _quiz_fetch_locks.setdefault(key, _threading.Lock())
        with fetch_lock:
            val = fresh()
            if val is None:
                val = fb_dict(fetch())
                if val is None:
                    return None
                _quiz_cache[key] = (_time.monotonic(), val)
    # Callers normalize and mutate quiz data in place, so never hand out the cached object.
    return _copy.deepcopy(val)


def get_quiz_cached(quiz_id: str) -> Optional[Dict[str, Any]]:
    from firebase_admin import db
    return _cached_fetch(f"quiz:{quiz_id}", lambda: db.reference(f"quizzes/{quiz_id}").get())


def get_quiz_id_for_access_code_cached(access_code: str) -> Optional[str]:
    from firebase_admin import db
    mapping = _cached_fetch(f"access:{access_code}", lambda: db.reference(f"quiz_access/{access_code}").get())
    return (mapping or {}).get("quiz_id") or None


def invalidate_quiz_cache(quiz_id: Optional[str] = None, access_code: Optional[str] = None) -> None:
    if quiz_id:
        _quiz_cache.pop(f"quiz:{quiz_id}", None)
    if access_code:
        _quiz_cache.pop(f"access:{access_code}", None)
