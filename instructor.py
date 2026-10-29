"""Instructor router — OTP auth, dashboard, quiz CRUD, share-link generation.

Mounted as a sub-router in main.py at prefix /instructor.
"""

import asyncio
import os
import shutil
import copy
import threading
import time

from fastapi import APIRouter, Request, HTTPException, Body, File, UploadFile, Form, Query
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse, Response
from fastapi.templating import Jinja2Templates
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
import json
import logging
import re
import secrets
import uuid
from urllib.parse import quote
from pathlib import Path

from firebase_utils import fb_dict, invalidate_quiz_cache
from quiz_analytics import (
    aggregate_quiz_analytics,
    build_user_ai_activity_log,
    collect_quiz_sessions_from_firebase,
    delete_users_data_for_quiz,
    export_activity_log_csv,
    activity_timeline_rows,
    agent_interaction_rows,
    autocomplete_suggestion_rows,
    autocomplete_timeline_events,
    export_agent_interactions_csv,
    export_autocomplete_csv,
    export_per_session_csv,
    find_user_session_payload_for_quiz,
    validate_analytics_user_id,
)

from otp import (
    generate_otp,
    verify_otp_value,
    store_otp,
    get_otp as get_otp_record,
    increment_otp_attempts,
    delete_otp,
    get_otp_provider,
    is_email_domain_allowed,
    sanitize_key,
    OTP_EXPIRY_MINUTES,
    OTP_MAX_ATTEMPTS,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/instructor", tags=["instructor"])
templates = Jinja2Templates(directory="templates")

# Analytics responses must stay fresh after Firebase deletes (avoid stale chart data in the browser).
_ANALYTICS_JSON_NO_CACHE = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
}

# In-memory aggregate cache (Firebase session scan + aggregate_quiz_analytics).
# live_now is merged on every request — not cached.
_analytics_aggregate_cache: Dict[str, Dict[str, Any]] = {}
_analytics_aggregate_cache_lock = threading.Lock()


def _analytics_cache_ttl_seconds() -> float:
    try:
        return max(5.0, float(os.getenv("ANALYTICS_AGGREGATE_CACHE_SECONDS", "120")))
    except (TypeError, ValueError):
        return 120.0


def invalidate_quiz_analytics_cache(quiz_id: str) -> None:
    """Drop cached aggregates for this quiz (e.g. after delete-user or quiz edit)."""
    q = (quiz_id or "").strip()
    if not q:
        return
    with _analytics_aggregate_cache_lock:
        _analytics_aggregate_cache.pop(q, None)
        _quiz_sessions_cache.pop(q, None)


def _get_cached_analytics_aggregate(quiz_id: str, quiz_updated_at: Optional[str]) -> Optional[dict]:
    with _analytics_aggregate_cache_lock:
        ent = _analytics_aggregate_cache.get(quiz_id)
        if not ent:
            return None
        if time.monotonic() > float(ent.get("expires", 0)):
            _analytics_aggregate_cache.pop(quiz_id, None)
            return None
        if (quiz_updated_at or "") != str(ent.get("quiz_updated_at") or ""):
            _analytics_aggregate_cache.pop(quiz_id, None)
            return None
        return copy.deepcopy(ent.get("data"))


def _set_cached_analytics_aggregate(
    quiz_id: str, quiz_updated_at: Optional[str], data: dict
) -> None:
    """Store aggregate without live_now (caller must not rely on live_now in data)."""
    payload = copy.deepcopy(data)
    payload.pop("live_now", None)
    ttl = _analytics_cache_ttl_seconds()
    with _analytics_aggregate_cache_lock:
        _analytics_aggregate_cache[quiz_id] = {
            "expires": time.monotonic() + ttl,
            "quiz_updated_at": quiz_updated_at or "",
            "data": payload,
        }


# Raw session payloads per quiz, shared by the analytics page, exports and every per-student
# activity log (each of those used to rescan all sessions in Firebase). Same TTL as aggregates.
_QUIZ_SESSIONS_CACHE_MAX_QUIZZES = 4
_quiz_sessions_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
_quiz_sessions_fetch_locks: Dict[str, threading.Lock] = {}


def _get_quiz_sessions(db, quiz_id: str, *, bypass_cache: bool = False) -> List[Dict[str, Any]]:
    """Blocking (call via asyncio.to_thread). One Firebase scan per quiz at a time per worker."""
    def fresh() -> Optional[List[Dict[str, Any]]]:
        ent = _quiz_sessions_cache.get(quiz_id)
        return ent[1] if ent and time.monotonic() < ent[0] else None

    with _analytics_aggregate_cache_lock:
        fetch_lock = _quiz_sessions_fetch_locks.setdefault(quiz_id, threading.Lock())
    sessions = None if bypass_cache else fresh()
    if sessions is None:
        with fetch_lock:
            sessions = None if bypass_cache else fresh()
            if sessions is None:
                sessions = collect_quiz_sessions_from_firebase(db, quiz_id)
                with _analytics_aggregate_cache_lock:
                    _quiz_sessions_cache[quiz_id] = (time.monotonic() + _analytics_cache_ttl_seconds(), sessions)
                    while len(_quiz_sessions_cache) > _QUIZ_SESSIONS_CACHE_MAX_QUIZZES:
                        oldest = min(_quiz_sessions_cache, key=lambda k: _quiz_sessions_cache[k][0])
                        _quiz_sessions_cache.pop(oldest, None)
    # Analytics helpers may normalize payloads in place; keep the cached copy pristine.
    return copy.deepcopy(sessions)


def _compute_analytics_aggregate(db, quiz_id: str, labels: List[str], *, bypass_cache: bool = False) -> dict:
    sessions = _get_quiz_sessions(db, quiz_id, bypass_cache=bypass_cache)
    return aggregate_quiz_analytics(sessions, quiz_id, labels)


def _attach_live_now_to_analytics(data: dict, quiz_id: str, labels: List[str]) -> None:
    from main import get_active_quiz_session_counts

    live = get_active_quiz_session_counts(quiz_id)
    live_by_problem = [0] * len(labels)
    for idx, c in (live.get("by_problem_index") or {}).items():
        try:
            i = int(idx)
        except (TypeError, ValueError):
            continue
        if 0 <= i < len(live_by_problem):
            live_by_problem[i] = int(c)
    data["live_now"] = {
        "total_active": int(live.get("total_active") or 0),
        "by_problem": live_by_problem,
        "scope_note": "“Active now” merges this server’s in-memory sessions with Firebase presence heartbeats (same project as localhost and production). Optional REDIS_URL shares counts across workers on one deployment.",
    }


def _load_analytics_payload_for_request(
    db,
    quiz_id: str,
    quiz: dict,
    labels: List[str],
    *,
    bypass_cache: bool,
) -> Tuple[dict, bool]:
    """Return (payload, cache_hit). Always includes fresh live_now."""
    quiz_updated_at = quiz.get("updated_at")
    if not bypass_cache:
        cached = _get_cached_analytics_aggregate(quiz_id, quiz_updated_at)
        if cached is not None:
            _attach_live_now_to_analytics(cached, quiz_id, labels)
            return cached, True

    data = _compute_analytics_aggregate(db, quiz_id, labels, bypass_cache=bypass_cache)
    _set_cached_analytics_aggregate(quiz_id, quiz_updated_at, data)
    _attach_live_now_to_analytics(data, quiz_id, labels)
    return data, False


# Instructor quiz builder: default survey question banks (editable JSON on disk)
_DEFAULT_SURVEY_TEMPLATE_FILES = {
    "pre": Path("surveys/instructor_default_pre_survey.json"),
    "post": Path("surveys/instructor_default_post_survey.json"),
    "recurrent": Path("surveys/instructor_default_recurrent_survey.json"),
    "demographics": Path("surveys/instructor_demographics.json"),
    "post_autocomplete": Path("surveys/instructor_post_autocomplete.json"),
    "post_agent": Path("surveys/instructor_post_agent.json"),
    # The four autocompletion study tasks (statement, starter files with tests, side-panel questions)
    "autocomplete_tasks": Path("surveys/default_autocomplete_tasks.json"),
    # The four coding-agent study tasks (same format; Task 1 adds the diagram question to the condition 3 post-survey)
    "agent_tasks": Path("surveys/default_agent_tasks.json"),
}

# Per-quiz survey question images (uploaded by instructor); served via GET /quiz-images/{asset_id}/{filename}
QUIZ_ASSETS_DIR = Path("surveys") / "quiz_assets"
ALLOWED_QUIZ_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"}


def _sanitize_quiz_asset_filename(name: str) -> str:
    base = Path(name).name
    stem = Path(base).stem
    suf = Path(base).suffix.lower()
    if suf not in ALLOWED_QUIZ_IMAGE_EXT:
        suf = ".png"
    clean = re.sub(r"[^a-zA-Z0-9._-]", "_", stem)[:160] or "image"
    return clean + suf


def _rewrite_quiz_image_ids(obj: object, old_id: str, new_id: str) -> None:
    """Rewrite image.src from old_id/filename → new_id/filename everywhere in nested structures."""
    prefix = old_id + "/"
    if isinstance(obj, dict):
        im = obj.get("image")
        if isinstance(im, dict) and isinstance(im.get("src"), str):
            s = im["src"]
            if s.startswith(prefix):
                im["src"] = new_id + "/" + s[len(prefix) :]
        for v in obj.values():
            _rewrite_quiz_image_ids(v, old_id, new_id)
    elif isinstance(obj, list):
        for x in obj:
            _rewrite_quiz_image_ids(x, old_id, new_id)


@router.get("/default-survey-templates/{which}")
async def get_default_survey_templates(which: str):
    """Return default pre/post/recurrent question arrays from `surveys/instructor_default_*.json`."""
    path = _DEFAULT_SURVEY_TEMPLATE_FILES.get(which)
    if not path or not path.is_file():
        raise HTTPException(status_code=404, detail="Unknown or missing survey template")
    with open(path, encoding="utf-8") as f:
        return JSONResponse(json.load(f))


@router.post("/upload-survey-image")
async def upload_survey_image(
    request: Request,
    file: UploadFile = File(...),
    draft_upload_id: Optional[str] = Form(None),
    quiz_id: Optional[str] = Form(None),
):
    """Store image under surveys/quiz_assets/{draft_id|quiz_id}/. Returns image.src like \"uuid/filename.png\" for question JSON."""
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"success": False, "error": "Not authenticated"}, status_code=401)

    did = (draft_upload_id or "").strip()
    qid = (quiz_id or "").strip()
    if bool(did) == bool(qid):
        return JSONResponse(
            {"success": False, "error": "Send exactly one of draft_upload_id or quiz_id"},
            status_code=400,
        )

    asset_id = qid if qid else did
    if qid:
        fb = _get_firebase()
        if fb:
            from firebase_admin import db
            quiz = fb_dict(db.reference(f"quizzes/{qid}").get())
            if not quiz or quiz.get("created_by") != email:
                return JSONResponse({"success": False, "error": "Not authorised"}, status_code=403)

    raw_name = file.filename or "image.png"
    safe_name = _sanitize_quiz_asset_filename(raw_name)
    ext = Path(safe_name).suffix.lower()
    if ext not in ALLOWED_QUIZ_IMAGE_EXT:
        return JSONResponse({"success": False, "error": f"File type not allowed ({ext})"}, status_code=400)

    dest_dir = QUIZ_ASSETS_DIR / asset_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / safe_name
    if dest_path.exists():
        stem = Path(safe_name).stem
        safe_name = f"{stem}_{secrets.token_hex(4)}{ext}"
        dest_path = dest_dir / safe_name

    contents = await file.read()
    if len(contents) > 5 * 1024 * 1024:
        return JSONResponse({"success": False, "error": "File too large (max 5 MB)"}, status_code=400)
    dest_path.write_bytes(contents)

    src = f"{asset_id}/{safe_name}"
    logger.info("Instructor uploaded survey image %s -> %s", email, src)
    return JSONResponse({"success": True, "src": src})


# ─── Helpers ────────────────────────────────────────────────────────────────

def _get_firebase():
    """Lazy import to avoid circular dependency with main.py."""
    from main import firebase_db
    return firebase_db


# How long an OTP login lasts on one browser before a new code is needed
INSTRUCTOR_LOGIN_HOURS = int(os.getenv("INSTRUCTOR_LOGIN_HOURS", "24"))


def _require_instructor(request: Request):
    """Return instructor email from session or None (also when the login is older than INSTRUCTOR_LOGIN_HOURS)."""
    if not request.session.get("is_instructor"):
        return None
    login_at = request.session.get("instructor_login_at")
    # Sessions from before the login time was recorded count as expired
    if not isinstance(login_at, (int, float)) or time.time() - login_at > INSTRUCTOR_LOGIN_HOURS * 3600:
        for k in ("instructor_email", "is_instructor", "instructor_login_at"):
            request.session.pop(k, None)
        return None
    return request.session.get("instructor_email")


def _clean_agent_skills(raw: Any) -> List[Dict[str, str]]:
    """Instructor-defined skills for the agent condition: [{name, instructions}], at most 20."""
    skills: List[Dict[str, str]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()[:60]
        instructions = str(item.get("instructions") or "").strip()[:4000]
        if name and instructions:
            skills.append({"name": name, "instructions": instructions})
    return skills[:20]


def _generate_access_code(length: int = 8) -> str:
    """Generate a high-entropy alphanumeric access code."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _normalize_quiz_data(quiz_data: dict) -> dict:
    """Backward-compat: wrap legacy single-problem/single-condition into list format."""
    if "problems" not in quiz_data and "problem_statement" in quiz_data:
        quiz_data["problems"] = [{
            "title": "Problem 1",
            "problem_statement": quiz_data.pop("problem_statement", ""),
            "constraints": quiz_data.pop("constraints", ""),
            "test_cases": "",
            "starter_code": quiz_data.pop("starter_code", {}),
        }]
    if "conditions" not in quiz_data and "condition" in quiz_data:
        quiz_data["conditions"] = [int(quiz_data.pop("condition", 1))]
    elif "conditions" not in quiz_data:
        quiz_data["conditions"] = [1]

    # Migrate quiz-level surveys into per-problem surveys if missing
    if "problems" in quiz_data:
        quiz_pre = quiz_data.get("pre_survey", [])
        quiz_post = quiz_data.get("post_survey", [])
        quiz_rec = quiz_data.get("recurrent_survey", [])
        quiz_rec_interval = quiz_data.get("recurrent_survey_interval", 4)
        quiz_rec_start = quiz_data.get("recurrent_survey_start", 5)
        for i, prob in enumerate(quiz_data["problems"]):
            if not (prob.get("title") or "").strip():
                prob["title"] = f"Problem {i + 1}"
            if "test_cases" not in prob:
                prob["test_cases"] = ""
            if not prob.get("_has_surveys"):
                prob["_has_surveys"] = True
                # If this problem already has its own survey question lists, do not replace them
                # with quiz-level copies (often empty) — that wiped problem 2+ on duplicate / load.
                has_own_surveys = any(
                    len(prob.get(k) or []) > 0
                    for k in ("pre_survey", "post_survey", "recurrent_survey")
                )
                if has_own_surveys:
                    if "pre_survey_enabled" not in prob:
                        prob["pre_survey_enabled"] = bool(prob.get("pre_survey"))
                    if "post_survey_enabled" not in prob:
                        prob["post_survey_enabled"] = bool(prob.get("post_survey"))
                    if "recurrent_survey_enabled" not in prob:
                        prob["recurrent_survey_enabled"] = bool(prob.get("recurrent_survey"))
                    if "recurrent_survey_interval" not in prob:
                        prob["recurrent_survey_interval"] = quiz_rec_interval
                    if "recurrent_survey_start" not in prob:
                        prob["recurrent_survey_start"] = quiz_rec_start
                else:
                    prob["pre_survey_enabled"] = bool(quiz_pre)
                    prob["pre_survey"] = quiz_pre
                    prob["post_survey_enabled"] = bool(quiz_post)
                    prob["post_survey"] = quiz_post
                    prob["recurrent_survey_enabled"] = bool(quiz_rec)
                    prob["recurrent_survey"] = quiz_rec
                    prob["recurrent_survey_interval"] = quiz_rec_interval
                    prob["recurrent_survey_start"] = quiz_rec_start

    return quiz_data


# ─── OTP Auth Routes ────────────────────────────────────────────────────────

@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    # Still signed in on this browser (within INSTRUCTOR_LOGIN_HOURS): no new OTP needed
    if _require_instructor(request):
        return RedirectResponse(url="/instructor/dashboard", status_code=303)
    error = request.query_params.get("error")
    return templates.TemplateResponse("instructor_login.html", {
        "request": request,
        "error": error,
        "login_hours": INSTRUCTOR_LOGIN_HOURS,
    })


@router.post("/send-otp", response_class=HTMLResponse)
async def send_otp(request: Request):
    form = await request.form()
    email = str(form.get("email") or "").lower().strip()

    if "@" not in email:
        return templates.TemplateResponse("instructor_login.html", {
            "request": request,
            "error": "Invalid email format.",
        })

    if not is_email_domain_allowed(email):
        return templates.TemplateResponse("instructor_login.html", {
            "request": request,
            "error": "Email domain not allowed. Please use an approved domain.",
        })

    otp_plain, otp_hash, salt = generate_otp()
    expiry = datetime.utcnow() + timedelta(minutes=OTP_EXPIRY_MINUTES)
    store_otp(_get_firebase(), email, otp_hash, salt, expiry)

    provider = get_otp_provider()
    sent = provider.send(email, otp_plain)
    if not sent:
        logger.error(f"OTP send failed for {email}")
        return templates.TemplateResponse("instructor_login.html", {
            "request": request,
            "error": "Failed to send OTP email. Please check SMTP settings and try again.",
        })
    logger.info(f"OTP sent to {email}")

    return templates.TemplateResponse("instructor_login.html", {
        "request": request,
        "otp_sent": True,
        "email": email,
        "success": f"OTP sent to {email}. Valid for {OTP_EXPIRY_MINUTES} minutes.",
    })


@router.post("/verify-otp", response_class=HTMLResponse)
async def verify_otp(request: Request):
    form = await request.form()
    email = str(form.get("email") or "").lower().strip()
    otp_input = str(form.get("otp") or "").strip()

    stored = get_otp_record(_get_firebase(), email)

    if not stored:
        return templates.TemplateResponse("instructor_login.html", {
            "request": request,
            "error": "OTP expired or not found. Please request a new one.",
        })

    if datetime.utcnow() > stored["expires"]:
        delete_otp(_get_firebase(), email)
        return templates.TemplateResponse("instructor_login.html", {
            "request": request,
            "error": "OTP expired. Please request a new one.",
        })

    if stored["attempts"] >= OTP_MAX_ATTEMPTS:
        delete_otp(_get_firebase(), email)
        return templates.TemplateResponse("instructor_login.html", {
            "request": request,
            "error": "Too many failed attempts. Please request a new OTP.",
        })

    if verify_otp_value(otp_input, stored["otp_hash"], stored["salt"]):
        delete_otp(_get_firebase(), email)
        request.session["instructor_email"] = email
        request.session["is_instructor"] = True
        request.session["instructor_login_at"] = int(time.time())

        # Ensure instructor record exists in Firebase
        fb = _get_firebase()
        if fb:
            from firebase_admin import db
            sanitized = sanitize_key(email)
            ref = db.reference(f"instructors/{sanitized}")
            existing = ref.get()
            if not existing:
                ref.set({"email": email, "created_at": datetime.utcnow().isoformat()})

        logger.info(f"Instructor login success: {email}")
        return RedirectResponse(url="/instructor/dashboard", status_code=303)
    else:
        new_attempts = stored["attempts"] + 1
        increment_otp_attempts(_get_firebase(), email, new_attempts)
        remaining = OTP_MAX_ATTEMPTS - new_attempts
        return templates.TemplateResponse("instructor_login.html", {
            "request": request,
            "otp_sent": True,
            "email": email,
            "error": f"Invalid OTP. {remaining} attempts remaining.",
        })


@router.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/instructor/login", status_code=303)


# ─── Dashboard ──────────────────────────────────────────────────────────────

@router.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request):
    email = _require_instructor(request)
    if not email:
        return RedirectResponse(url="/instructor/login", status_code=303)

    quizzes = []
    fb = _get_firebase()
    if fb:
        from firebase_admin import db
        sanitized = sanitize_key(email)
        quiz_ids = fb_dict(await asyncio.to_thread(
            lambda: db.reference(f"instructors/{sanitized}/quizzes").get())) or {}
        # Read only this instructor's quizzes (not the whole quizzes/ tree), in parallel.
        fetched = await asyncio.gather(*(
            asyncio.to_thread(lambda q=qid: db.reference(f"quizzes/{q}").get()) for qid in quiz_ids
        ))
        for qid, raw in zip(quiz_ids, fetched):
            qdata = fb_dict(raw)
            if qdata:
                qdata["id"] = qid
                quizzes.append(qdata)
        quizzes.sort(key=lambda q: q.get("created_at", ""), reverse=True)

        from main import get_active_quiz_session_counts

        counts = await asyncio.gather(*(
            asyncio.to_thread(get_active_quiz_session_counts, q["id"]) for q in quizzes
        ))
        for q, live in zip(quizzes, counts):
            q["active_now"] = int(live.get("total_active") or 0)

    return templates.TemplateResponse("instructor_dashboard.html", {
        "request": request,
        "instructor_email": email,
        "quizzes": quizzes,
    })


# ─── Quiz CRUD ──────────────────────────────────────────────────────────────

@router.get("/create-quiz", response_class=HTMLResponse)
async def create_quiz_page(request: Request):
    email = _require_instructor(request)
    if not email:
        return RedirectResponse(url="/instructor/login", status_code=303)
    return templates.TemplateResponse("instructor_quiz_form.html", {
        "request": request,
        "instructor_email": email,
        "quiz": None,
        "edit_mode": False,
        "draft_upload_id": str(uuid.uuid4()),
    })


@router.post("/save-quiz")
async def save_quiz(request: Request, payload: dict = Body(...)):
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"success": False, "error": "Not authenticated"}, status_code=401)

    # Derive title for internal use: teaser, first problem title, or "Quiz"
    teaser = (payload.get("teaser") or "").strip()
    problems = payload.get("problems", [])
    first_prob_title = (problems[0].get("title") or "").strip() if problems else ""
    title = teaser or first_prob_title or "Quiz"

    # Validate problems list (at least one required)
    if not problems or not isinstance(problems, list):
        return JSONResponse({"success": False, "error": "At least one problem is required."}, status_code=400)
    problems = copy.deepcopy(problems)
    for i, prob in enumerate(problems):
        if not (prob.get("title") or "").strip():
            return JSONResponse({"success": False, "error": f"Problem {i+1} requires a title."}, status_code=400)
        if not (prob.get("problem_statement") or "").strip():
            return JSONResponse({"success": False, "error": f"Problem {i+1} requires a problem statement."}, status_code=400)

    # Validate conditions (list, each must be 1, 2, or 3)
    conditions = payload.get("conditions", [1])
    if not conditions or not isinstance(conditions, list):
        return JSONResponse({"success": False, "error": "At least one condition is required."}, status_code=400)
    for c in conditions:
        if int(c) not in (1, 2, 3):
            return JSONResponse({"success": False, "error": "Each condition must be 1, 2, or 3."}, status_code=400)
    conditions = [int(c) for c in conditions]

    quiz_id = str(uuid.uuid4())
    access_code = _generate_access_code()

    draft_id = (payload.get("draft_upload_id") or "").strip()
    if draft_id:
        src_dir = QUIZ_ASSETS_DIR / draft_id
        dst_dir = QUIZ_ASSETS_DIR / quiz_id
        if src_dir.exists() and src_dir.is_dir():
            if dst_dir.exists():
                shutil.rmtree(dst_dir, ignore_errors=True)
            shutil.move(str(src_dir), str(dst_dir))
        _rewrite_quiz_image_ids(problems, draft_id, quiz_id)

    quiz_data = {
        "id": quiz_id,
        "title": title,
        "description": "",
        "teaser": teaser,
        "problems": problems,
        "allowed_languages": payload.get("allowed_languages", ["python", "javascript", "c", "cpp", "java"]),
        "time_limit_minutes": int(payload.get("time_limit_minutes", 0)),
        "conditions": conditions,
        "agent_skills": _clean_agent_skills(payload.get("agent_skills")),
        "recurrent_survey": payload.get("recurrent_survey", []),
        "recurrent_survey_interval": int(payload.get("recurrent_survey_interval", 4)),
        "recurrent_survey_start": int(payload.get("recurrent_survey_start", 5)),
        "pre_survey": payload.get("pre_survey", []),
        "post_survey": payload.get("post_survey", []),
        "published": payload.get("published", False),
        "availability_start": payload.get("availability_start") or None,
        "availability_end": payload.get("availability_end") or None,
        "paste_allowed": payload.get("paste_allowed", True),
        "tab_tracking_enabled": payload.get("tab_tracking_enabled", True),
        "access_code": access_code,
        "created_by": email,
        "created_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat(),
    }

    fb = _get_firebase()
    if fb:
        from firebase_admin import db
        db.reference(f"quizzes/{quiz_id}").set(quiz_data)
        db.reference(f"quiz_access/{access_code}").set({
            "quiz_id": quiz_id,
            "created_at": datetime.utcnow().isoformat(),
        })
        db.reference(f"instructors/{sanitize_key(email)}/quizzes/{quiz_id}").set(True)

    return JSONResponse({"success": True, "quiz_id": quiz_id, "access_code": access_code})


@router.post("/duplicate-quiz/{quiz_id}")
async def duplicate_quiz(request: Request, quiz_id: str):
    """Copy an existing quiz to a new draft (new id, access code, and asset folder)."""
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"success": False, "error": "Not authenticated"}, status_code=401)

    fb = _get_firebase()
    if not fb:
        return JSONResponse({"success": False, "error": "Database unavailable"}, status_code=503)

    from firebase_admin import db

    existing = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
    if not existing:
        return JSONResponse({"success": False, "error": "Quiz not found"}, status_code=404)
    if existing.get("created_by") != email:
        return JSONResponse({"success": False, "error": "Not authorised"}, status_code=403)

    src_quiz = _normalize_quiz_data(copy.deepcopy(existing))
    problems = copy.deepcopy(src_quiz.get("problems", []))
    if not problems or not isinstance(problems, list):
        return JSONResponse({"success": False, "error": "Quiz has no problems to copy."}, status_code=400)

    first_prob_title = (problems[0].get("title") or "").strip() if problems else ""
    base_teaser = (src_quiz.get("teaser") or "").strip()
    if base_teaser:
        teaser = base_teaser + " (Copy)"
    elif first_prob_title:
        teaser = first_prob_title + " (Copy)"
    else:
        teaser = "Quiz (Copy)"
    title = teaser or first_prob_title or "Quiz"

    raw_conds = src_quiz.get("conditions") or [1]
    conditions: List[int] = []
    for c in raw_conds:
        try:
            ic = int(c)
        except (TypeError, ValueError):
            continue
        if ic in (1, 2, 3):
            conditions.append(ic)
    if not conditions:
        conditions = [1]

    new_id = str(uuid.uuid4())
    access_code = _generate_access_code()
    now = datetime.utcnow().isoformat()

    src_dir = QUIZ_ASSETS_DIR / quiz_id
    dst_dir = QUIZ_ASSETS_DIR / new_id
    if src_dir.exists() and src_dir.is_dir():
        if dst_dir.exists():
            shutil.rmtree(dst_dir, ignore_errors=True)
        shutil.copytree(src_dir, dst_dir)

    quiz_data = {
        "id": new_id,
        "title": title,
        "description": "",
        "teaser": teaser,
        "problems": problems,
        "allowed_languages": src_quiz.get("allowed_languages", ["python", "javascript", "c", "cpp", "java"]),
        "time_limit_minutes": int(src_quiz.get("time_limit_minutes", 0)),
        "conditions": conditions,
        "agent_skills": copy.deepcopy(src_quiz.get("agent_skills", [])),
        "recurrent_survey": copy.deepcopy(src_quiz.get("recurrent_survey", [])),
        "recurrent_survey_interval": int(src_quiz.get("recurrent_survey_interval", 4)),
        "recurrent_survey_start": int(src_quiz.get("recurrent_survey_start", 5)),
        "pre_survey": copy.deepcopy(src_quiz.get("pre_survey", [])),
        "post_survey": copy.deepcopy(src_quiz.get("post_survey", [])),
        "published": False,
        "availability_start": src_quiz.get("availability_start") or None,
        "availability_end": src_quiz.get("availability_end") or None,
        "paste_allowed": src_quiz.get("paste_allowed", True),
        "tab_tracking_enabled": src_quiz.get("tab_tracking_enabled", True),
        "access_code": access_code,
        "created_by": email,
        "created_at": now,
        "updated_at": now,
    }
    _rewrite_quiz_image_ids(quiz_data, quiz_id, new_id)

    db.reference(f"quizzes/{new_id}").set(quiz_data)
    db.reference(f"quiz_access/{access_code}").set({
        "quiz_id": new_id,
        "created_at": now,
    })
    db.reference(f"instructors/{sanitize_key(email)}/quizzes/{new_id}").set(True)

    return JSONResponse({"success": True, "quiz_id": new_id, "access_code": access_code})


@router.get("/edit-quiz/{quiz_id}", response_class=HTMLResponse)
async def edit_quiz_page(request: Request, quiz_id: str):
    email = _require_instructor(request)
    if not email:
        return RedirectResponse(url="/instructor/login", status_code=303)

    fb = _get_firebase()
    quiz = None
    if fb:
        from firebase_admin import db
        quiz = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")
    if quiz.get("created_by") != email:
        raise HTTPException(status_code=403, detail="Not authorised to edit this quiz")

    quiz["id"] = quiz_id
    # Normalize legacy quizzes (single problem/condition) into new list format
    quiz = _normalize_quiz_data(quiz)
    return templates.TemplateResponse("instructor_quiz_form.html", {
        "request": request,
        "instructor_email": email,
        "quiz": quiz,
        "edit_mode": True,
        "draft_upload_id": None,
    })


@router.post("/update-quiz/{quiz_id}")
async def update_quiz(request: Request, quiz_id: str, payload: dict = Body(...)):
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"success": False, "error": "Not authenticated"}, status_code=401)

    fb = _get_firebase()
    if not fb:
        return JSONResponse({"success": False, "error": "Database unavailable"}, status_code=503)

    from firebase_admin import db
    existing = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
    if not existing:
        return JSONResponse({"success": False, "error": "Quiz not found"}, status_code=404)
    if existing.get("created_by") != email:
        return JSONResponse({"success": False, "error": "Not authorised"}, status_code=403)

    # Validate conditions if provided
    conditions = payload.get("conditions")
    if conditions is not None:
        if not isinstance(conditions, list) or not conditions:
            return JSONResponse({"success": False, "error": "At least one condition is required."}, status_code=400)
        for c in conditions:
            if int(c) not in (1, 2, 3):
                return JSONResponse({"success": False, "error": "Each condition must be 1, 2, or 3."}, status_code=400)
        payload["conditions"] = [int(c) for c in conditions]

    # Validate problems if provided
    problems = payload.get("problems")
    if problems is not None:
        if not isinstance(problems, list) or not problems:
            return JSONResponse({"success": False, "error": "At least one problem is required."}, status_code=400)
        for i, prob in enumerate(problems):
            if not (prob.get("title") or "").strip():
                return JSONResponse({"success": False, "error": f"Problem {i+1} requires a title."}, status_code=400)
            if not (prob.get("problem_statement") or "").strip():
                return JSONResponse({"success": False, "error": f"Problem {i+1} requires a problem statement."}, status_code=400)

    updatable_fields = [
        "teaser", "problems",
        "allowed_languages", "time_limit_minutes", "conditions",
        "recurrent_survey", "recurrent_survey_interval", "recurrent_survey_start",
        "pre_survey", "post_survey",
        "published", "availability_start", "availability_end",
        "paste_allowed", "tab_tracking_enabled",
    ]
    updates = {k: payload[k] for k in updatable_fields if k in payload}
    if "agent_skills" in payload:
        updates["agent_skills"] = _clean_agent_skills(payload.get("agent_skills"))
    # Derive title from teaser or first problem
    teaser = (payload.get("teaser") or "").strip()
    problems = payload.get("problems") or existing.get("problems", [])
    first_title = (problems[0].get("title") or "").strip() if problems else ""
    updates["title"] = teaser or first_title or "Quiz"
    updates["description"] = ""
    updates["updated_at"] = datetime.utcnow().isoformat()

    db.reference(f"quizzes/{quiz_id}").update(updates)
    invalidate_quiz_cache(quiz_id)
    invalidate_quiz_analytics_cache(quiz_id)
    return JSONResponse({"success": True, "quiz_id": quiz_id})


@router.delete("/delete-quiz/{quiz_id}")
async def delete_quiz(request: Request, quiz_id: str):
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"success": False, "error": "Not authenticated"}, status_code=401)

    fb = _get_firebase()
    if not fb:
        return JSONResponse({"success": False, "error": "Database unavailable"}, status_code=503)

    from firebase_admin import db
    existing = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
    if not existing:
        return JSONResponse({"success": False, "error": "Quiz not found"}, status_code=404)
    if existing.get("created_by") != email:
        return JSONResponse({"success": False, "error": "Not authorised"}, status_code=403)

    access_code = existing.get("access_code", "")
    db.reference(f"quizzes/{quiz_id}").delete()
    if access_code:
        db.reference(f"quiz_access/{access_code}").delete()
    db.reference(f"instructors/{sanitize_key(email)}/quizzes/{quiz_id}").delete()

    qdir = QUIZ_ASSETS_DIR / quiz_id
    if qdir.exists() and qdir.is_dir():
        shutil.rmtree(qdir, ignore_errors=True)

    invalidate_quiz_cache(quiz_id, access_code)
    invalidate_quiz_analytics_cache(quiz_id)
    return JSONResponse({"success": True})


@router.post("/toggle-publish/{quiz_id}")
async def toggle_publish(request: Request, quiz_id: str):
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"success": False, "error": "Not authenticated"}, status_code=401)

    fb = _get_firebase()
    if not fb:
        return JSONResponse({"success": False, "error": "Database unavailable"}, status_code=503)

    from firebase_admin import db
    existing = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
    if not existing:
        return JSONResponse({"success": False, "error": "Quiz not found"}, status_code=404)
    if existing.get("created_by") != email:
        return JSONResponse({"success": False, "error": "Not authorised"}, status_code=403)

    new_status = not existing.get("published", False)
    db.reference(f"quizzes/{quiz_id}/published").set(new_status)
    invalidate_quiz_cache(quiz_id)
    invalidate_quiz_analytics_cache(quiz_id)
    return JSONResponse({"success": True, "published": new_status})


def _safe_quiz_export_slug(quiz_id: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9._-]", "_", (quiz_id or "").strip())[:100]
    return s or "quiz"


def _quiz_problem_labels(quiz: dict) -> List[str]:
    probs = quiz.get("problems") or []
    labels: List[str] = []
    for i, p in enumerate(probs):
        t = (p.get("title") or "").strip() if isinstance(p, dict) else ""
        labels.append(t or f"Problem {i + 1}")
    return labels or ["Problem 1"]


@router.get("/quiz/{quiz_id}/analytics", response_class=HTMLResponse)
async def quiz_analytics_page(request: Request, quiz_id: str):
    email = _require_instructor(request)
    if not email:
        return RedirectResponse(url="/instructor/login", status_code=303)

    fb = _get_firebase()
    if not fb:
        return templates.TemplateResponse(
            "instructor_quiz_analytics.html",
            {
                "request": request,
                "instructor_email": email,
                "quiz_id": quiz_id,
                "quiz_teaser": "",
                "problem_labels": [],
                "firebase_available": False,
            },
        )

    from firebase_admin import db

    quiz = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")
    if quiz.get("created_by") != email:
        raise HTTPException(status_code=403, detail="Not authorised to view this quiz")

    quiz = _normalize_quiz_data(quiz)
    labels = _quiz_problem_labels(quiz)
    return templates.TemplateResponse(
        "instructor_quiz_analytics.html",
        {
            "request": request,
            "instructor_email": email,
            "quiz_id": quiz_id,
            "quiz_teaser": (quiz.get("teaser") or quiz.get("title") or "").strip(),
            "problem_labels": labels,
            "firebase_available": True,
        },
    )


@router.get("/quiz/{quiz_id}/activity-log", response_class=HTMLResponse)
async def quiz_activity_log_page(
    request: Request,
    quiz_id: str,
    user_id: str = Query(..., description="Student user id (Firebase)"),
):
    """Per-user AI suggestion log: timestamps, suggestions, accept/reject, code snapshots."""
    email = _require_instructor(request)
    if not email:
        return RedirectResponse(url="/instructor/login", status_code=303)

    try:
        uid = validate_analytics_user_id(user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid user id")

    uid_q = quote(uid, safe="")

    fb = _get_firebase()
    if not fb:
        return templates.TemplateResponse(
            "instructor_activity_log.html",
            {
                "request": request,
                "instructor_email": email,
                "quiz_id": quiz_id,
                "quiz_teaser": "",
                "user_id": uid,
                "user_id_query": uid_q,
                "programming_language": "",
                "log_rows": [],
                "problem_tables": [],
                "session_id": None,
                "error": "Database unavailable",
                "firebase_available": False,
            },
        )

    from firebase_admin import db

    quiz = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found")
    if quiz.get("created_by") != email:
        raise HTTPException(status_code=403, detail="Not authorised")

    quiz = _normalize_quiz_data(quiz)
    labels = _quiz_problem_labels(quiz)
    n_prob = max(1, len(labels))

    sessions = await asyncio.to_thread(_get_quiz_sessions, db, quiz_id)
    payload = find_user_session_payload_for_quiz(sessions, quiz_id, uid, n_prob)
    if not payload:
        return templates.TemplateResponse(
            "instructor_activity_log.html",
            {
                "request": request,
                "instructor_email": email,
                "quiz_id": quiz_id,
                "quiz_teaser": (quiz.get("teaser") or quiz.get("title") or "").strip(),
                "user_id": uid,
                "user_id_query": uid_q,
                "programming_language": "",
                "log_rows": [],
                "problem_tables": [],
                "session_id": None,
                "error": "No session found for this user on this quiz.",
                "firebase_available": True,
            },
        )

    sm = payload.get("session_metadata")
    prog_lang = ""
    session_condition = None
    if isinstance(sm, dict):
        prog_lang = str(sm.get("programming_language") or "").strip()
        session_condition = sm.get("condition")

    log = build_user_ai_activity_log(payload, labels)
    rows = log.get("rows") or []
    problem_tables = log.get("problem_tables") or []

    # Autocomplete (C2) and coding agent (C3) sessions have their own per-interaction views.
    ai_view = "legacy"
    agent_rows: List[Dict[str, Any]] = []
    suggestion_rows: List[Dict[str, Any]] = []
    try:
        cond_int = int(session_condition) if session_condition is not None else None
    except (TypeError, ValueError):
        cond_int = None
    if cond_int == 3:
        ai_view, agent_rows = "agent", agent_interaction_rows(payload)
    elif cond_int == 2:
        ai_view, suggestion_rows = "autocomplete", autocomplete_suggestion_rows(payload)
    if ai_view != "legacy":
        empty_msg = ("No agent interactions recorded for this session yet." if ai_view == "agent"
                     else "No autocomplete suggestions recorded for this session yet.")
        error = None if (agent_rows or suggestion_rows) else empty_msg
    else:
        error = None if rows else (
            "No AI suggestion rows in Firebase logs for this session (older submissions may lack `logs.ai_guesses`).")

    return templates.TemplateResponse(
        "instructor_activity_log.html",
        {
            "request": request,
            "instructor_email": email,
            "quiz_id": quiz_id,
            "quiz_teaser": (quiz.get("teaser") or quiz.get("title") or "").strip(),
            "user_id": log.get("user_id") or uid,
            "user_id_query": uid_q,
            "programming_language": prog_lang,
            "condition": session_condition,
            "log_rows": rows,
            "problem_tables": problem_tables,
            "session_id": log.get("session_id"),
            "error": error,
            "ai_view": ai_view,
            "agent_rows": agent_rows,
            "suggestion_rows": suggestion_rows,
            "autocomplete_events": autocomplete_timeline_events(payload) if ai_view == "autocomplete" else [],
            "problem_labels": labels,
            "activity_rows": activity_timeline_rows(payload),
            "firebase_available": True,
        },
    )


@router.get("/quiz/{quiz_id}/activity-log-data")
async def quiz_activity_log_data(
    request: Request,
    quiz_id: str,
    user_id: str = Query(..., description="Student user id (Firebase)"),
):
    """JSON for the same table as the activity-log page (export / tooling)."""
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    try:
        uid = validate_analytics_user_id(user_id)
    except ValueError:
        return JSONResponse({"error": "Invalid user id"}, status_code=400)

    fb = _get_firebase()
    if not fb:
        return JSONResponse({"error": "Database unavailable"}, status_code=503)

    from firebase_admin import db

    try:
        quiz = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
        if not quiz:
            return JSONResponse({"error": "Quiz not found"}, status_code=404)
        if quiz.get("created_by") != email:
            return JSONResponse({"error": "Not authorised"}, status_code=403)

        quiz = _normalize_quiz_data(quiz)
        labels = _quiz_problem_labels(quiz)
        n_prob = max(1, len(labels))

        sessions = await asyncio.to_thread(_get_quiz_sessions, db, quiz_id)
        payload = find_user_session_payload_for_quiz(sessions, quiz_id, uid, n_prob)
        if not payload:
            return JSONResponse({"error": "No session for this user"}, status_code=404)

        data = build_user_ai_activity_log(payload, labels)
        return JSONResponse(content=data, headers=_ANALYTICS_JSON_NO_CACHE)
    except Exception as e:
        logger.exception("quiz_activity_log_data failed for quiz_id=%s", quiz_id)
        return JSONResponse({"error": f"Server error: {e!s}"}, status_code=500)


@router.get("/quiz/{quiz_id}/activity-log-export")
async def quiz_activity_log_export(
    request: Request,
    quiz_id: str,
    user_id: str = Query(..., description="Student user id (Firebase)"),
    problem_index: Optional[int] = Query(
        None,
        description="If set, CSV for this problem only; omit for all problems in one file.",
    ),
):
    """Download activity log as CSV (per problem or combined)."""
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    try:
        uid = validate_analytics_user_id(user_id)
    except ValueError:
        return JSONResponse({"error": "Invalid user id"}, status_code=400)

    fb = _get_firebase()
    if not fb:
        return JSONResponse({"error": "Database unavailable"}, status_code=503)

    from firebase_admin import db

    try:
        quiz = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
        if not quiz:
            return JSONResponse({"error": "Quiz not found"}, status_code=404)
        if quiz.get("created_by") != email:
            return JSONResponse({"error": "Not authorised"}, status_code=403)

        quiz = _normalize_quiz_data(quiz)
        labels = _quiz_problem_labels(quiz)
        n_prob = max(1, len(labels))

        sessions = await asyncio.to_thread(_get_quiz_sessions, db, quiz_id)
        payload = find_user_session_payload_for_quiz(sessions, quiz_id, uid, n_prob)
        if not payload:
            return JSONResponse({"error": "No session for this user"}, status_code=404)

        log = build_user_ai_activity_log(payload, labels)
        problem_tables = log.get("problem_tables") or []
        csv_text = export_activity_log_csv(
            problem_tables,
            str(log.get("user_id") or uid),
            str(log.get("session_id") or "") or None,
            only_problem_index=problem_index,
        )
        if problem_index is not None and not csv_text.strip():
            return JSONResponse({"error": "No rows for this problem"}, status_code=404)

        qslug = _safe_quiz_export_slug(quiz_id)
        uslug = re.sub(r"[^a-zA-Z0-9._-]", "_", uid)[:80] or "user"
        if problem_index is not None:
            fname = f"{qslug}-activity-log-{uslug}-p{int(problem_index)}.csv"
        else:
            fname = f"{qslug}-activity-log-{uslug}-all.csv"

        bom = "\ufeff"
        h = dict(_ANALYTICS_JSON_NO_CACHE)
        h["Content-Disposition"] = f'attachment; filename="{fname}"'
        return Response(
            content=(bom + csv_text).encode("utf-8"),
            media_type="text/csv; charset=utf-8",
            headers=h,
        )
    except Exception as e:
        logger.exception("quiz_activity_log_export failed for quiz_id=%s", quiz_id)
        return JSONResponse({"error": f"Server error: {e!s}"}, status_code=500)


@router.get("/quiz/{quiz_id}/analytics-data")
async def quiz_analytics_data(
    request: Request,
    quiz_id: str,
    refresh: int = Query(0, description="Set to 1 to bypass server aggregate cache"),
):
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    fb = _get_firebase()
    if not fb:
        return JSONResponse({"error": "Database unavailable"}, status_code=503)

    from firebase_admin import db

    try:
        quiz = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
        if not quiz:
            return JSONResponse({"error": "Quiz not found"}, status_code=404)
        if quiz.get("created_by") != email:
            return JSONResponse({"error": "Not authorised"}, status_code=403)

        quiz = _normalize_quiz_data(quiz)
        labels = _quiz_problem_labels(quiz)
        bypass = bool(refresh) or bool(request.query_params.get("nocache"))
        data, cache_hit = await asyncio.to_thread(
            _load_analytics_payload_for_request, db, quiz_id, quiz, labels, bypass_cache=bypass
        )
        h = dict(_ANALYTICS_JSON_NO_CACHE)
        h["X-Analytics-Aggregate-Cache"] = "hit" if cache_hit else "miss"
        return JSONResponse(content=data, headers=h)
    except Exception as e:
        logger.exception("quiz_analytics_data failed for quiz_id=%s", quiz_id)
        return JSONResponse({"error": f"Server error: {e!s}"}, status_code=500)


@router.get("/quiz/{quiz_id}/diagram")
async def quiz_diagram_image(request: Request, quiz_id: str, session_id: str, diagram_id: str):
    """Image of a student's diagram answer (drawing snapshot or uploaded photo) for the analytics page."""
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", diagram_id) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", session_id):
        return JSONResponse({"error": "Invalid id"}, status_code=400)

    from firebase_admin import db
    from main import load_diagram_image

    quiz = fb_dict(await asyncio.to_thread(lambda: db.reference(f"quizzes/{quiz_id}").get())) if _get_firebase() else None
    if not quiz:
        return JSONResponse({"error": "Quiz not found"}, status_code=404)
    if quiz.get("created_by") != email:
        return JSONResponse({"error": "Not authorised"}, status_code=403)

    meta, data, media = await asyncio.to_thread(load_diagram_image, session_id, diagram_id)
    if data is None:
        return JSONResponse({"error": "Image not found"}, status_code=404)
    if not meta or str(meta.get("quiz_id") or "") != quiz_id:
        return JSONResponse({"error": "Not authorised"}, status_code=403)
    return Response(content=data, media_type=media, headers={"Cache-Control": "private, max-age=300"})


@router.post("/quiz/{quiz_id}/analytics-delete-user")
async def quiz_analytics_delete_user(
    request: Request, quiz_id: str, body: Optional[dict] = Body(default=None)
):
    """Remove stored Firebase session data for one user (``user_id``) or several (``user_ids``) on this quiz,
    and clear their matching active sessions."""
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"success": False, "error": "Not authenticated"}, status_code=401)

    fb = _get_firebase()
    if not fb:
        return JSONResponse({"success": False, "error": "Database unavailable"}, status_code=503)

    from firebase_admin import db

    raw = (body or {}).get("user_ids")
    if raw is None and (body or {}).get("user_id"):
        raw = [(body or {}).get("user_id")]
    if not isinstance(raw, list) or not raw or not all(isinstance(u, str) and u for u in raw):
        return JSONResponse({"success": False, "error": "user_id or user_ids required"}, status_code=400)
    if len(raw) > 500:
        return JSONResponse({"success": False, "error": "At most 500 users per request"}, status_code=400)

    try:
        quiz = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
        if not quiz:
            return JSONResponse({"success": False, "error": "Quiz not found"}, status_code=404)
        if quiz.get("created_by") != email:
            return JSONResponse({"success": False, "error": "Not authorised"}, status_code=403)

        result = await asyncio.to_thread(delete_users_data_for_quiz, db, quiz_id, raw)
        from main import forget_active_sessions_for_quiz_users

        result["cleared_active_sessions"] = await asyncio.to_thread(forget_active_sessions_for_quiz_users, quiz_id, raw)
        result["users_deleted"] = len(set(raw))
        invalidate_quiz_analytics_cache(quiz_id)
        return JSONResponse(content={"success": True, **result}, headers=_ANALYTICS_JSON_NO_CACHE)
    except ValueError as ve:
        return JSONResponse({"success": False, "error": str(ve)}, status_code=400)
    except Exception as e:
        logger.exception("quiz_analytics_delete_user failed")
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@router.get("/quiz/{quiz_id}/analytics-export")
async def quiz_analytics_export(
    request: Request,
    quiz_id: str,
    fmt: str = "csv",
    refresh: int = Query(0, description="Set to 1 to bypass server aggregate cache"),
):
    """Download per-session CSV (flattened) or full aggregate JSON for this quiz."""
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    fb = _get_firebase()
    if not fb:
        return JSONResponse({"error": "Database unavailable"}, status_code=503)

    from firebase_admin import db

    kind = (fmt or "csv").strip().lower()
    if kind not in ("csv", "json"):
        return JSONResponse({"error": "fmt must be csv or json"}, status_code=400)

    try:
        quiz = fb_dict(db.reference(f"quizzes/{quiz_id}").get())
        if not quiz:
            return JSONResponse({"error": "Quiz not found"}, status_code=404)
        if quiz.get("created_by") != email:
            return JSONResponse({"error": "Not authorised"}, status_code=403)

        quiz = _normalize_quiz_data(quiz)
        labels = _quiz_problem_labels(quiz)
        bypass = bool(refresh) or bool(request.query_params.get("nocache"))
        data, _cache_hit = await asyncio.to_thread(
            _load_analytics_payload_for_request, db, quiz_id, quiz, labels, bypass_cache=bypass
        )

        slug = _safe_quiz_export_slug(quiz_id)
        if kind == "json":
            blob = json.dumps(data, ensure_ascii=False, indent=2)
            h = dict(_ANALYTICS_JSON_NO_CACHE)
            h["Content-Disposition"] = f'attachment; filename="{slug}-analytics.json"'
            return Response(
                content=blob.encode("utf-8"),
                media_type="application/json; charset=utf-8",
                headers=h,
            )

        csv_text = export_per_session_csv(labels, data.get("per_session") or [])
        bom = "\ufeff"
        h = dict(_ANALYTICS_JSON_NO_CACHE)
        h["Content-Disposition"] = f'attachment; filename="{slug}-analytics-sessions.csv"'
        return Response(
            content=(bom + csv_text).encode("utf-8"),
            media_type="text/csv; charset=utf-8",
            headers=h,
        )
    except Exception as e:
        logger.exception("quiz_analytics_export failed")
        return JSONResponse({"error": f"Server error: {e!s}"}, status_code=500)


@router.get("/quiz/{quiz_id}/condition-export/{kind}")
async def quiz_condition_export(
    request: Request,
    quiz_id: str,
    kind: str,
    refresh: int = Query(0, description="Set to 1 to bypass server session cache"),
    user_id: Optional[str] = Query(None, description="Only this student"),
):
    """CSV of every agent interaction (kind=agent) or every autocomplete suggestion (kind=autocomplete)."""
    email = _require_instructor(request)
    if not email:
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    exporters = {"agent": export_agent_interactions_csv, "autocomplete": export_autocomplete_csv}
    if kind not in exporters:
        return JSONResponse({"error": "kind must be agent or autocomplete"}, status_code=400)

    fb = _get_firebase()
    if not fb:
        return JSONResponse({"error": "Database unavailable"}, status_code=503)

    from firebase_admin import db

    try:
        quiz = fb_dict(await asyncio.to_thread(lambda: db.reference(f"quizzes/{quiz_id}").get()))
        if not quiz:
            return JSONResponse({"error": "Quiz not found"}, status_code=404)
        if quiz.get("created_by") != email:
            return JSONResponse({"error": "Not authorised"}, status_code=403)

        labels = _quiz_problem_labels(_normalize_quiz_data(quiz))
        sessions = await asyncio.to_thread(_get_quiz_sessions, db, quiz_id, bypass_cache=bool(refresh))
        uid = validate_analytics_user_id(user_id) if user_id else None
        csv_text = await asyncio.to_thread(exporters[kind], sessions, quiz_id, labels, uid)

        h = dict(_ANALYTICS_JSON_NO_CACHE)
        name = "agent-interactions" if kind == "agent" else "autocomplete-suggestions"
        if uid:
            name += "-" + (re.sub(r"[^a-zA-Z0-9._-]", "_", uid)[:80] or "user")
        h["Content-Disposition"] = f'attachment; filename="{_safe_quiz_export_slug(quiz_id)}-{name}.csv"'
        return Response(
            content=("\ufeff" + csv_text).encode("utf-8"),
            media_type="text/csv; charset=utf-8",
            headers=h,
        )
    except Exception as e:
        logger.exception("quiz_condition_export failed")
        return JSONResponse({"error": f"Server error: {e!s}"}, status_code=500)
