"""Pydantic models for the instructor quiz-creation system.

These models are additive — the existing models in main.py are untouched.
"""

from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any


# ─── OTP ────────────────────────────────────────────────────────────────────

class OTPRequest(BaseModel):
    email: str


class OTPVerify(BaseModel):
    email: str
    otp: str


# ─── Survey Questions ───────────────────────────────────────────────────────

class SurveyQuestionCreate(BaseModel):
    """A single survey question attached to a quiz."""
    id: str = ""
    question: str
    type: str = "likert"  # likert, likert_7_with_na, multiple_choice, open_ended, slider, info_block
    required: bool = True
    options: List[str] = Field(default_factory=list)  # for multiple_choice
    scale: Optional[Dict[str, Any]] = None  # for likert/slider
    placeholder: str = ""
    max_length: Optional[int] = None
    min_length: Optional[int] = None
    help_text: str = ""
    content: str = ""  # for info_block
    # Optional image (filename under surveys/images/, served at /survey-images/{src})
    image: Optional[Dict[str, Any]] = None  # e.g. {"src": "x.png"}


# ─── Problem (per-problem data within a quiz) ──────────────────────────────

class ProblemCreate(BaseModel):
    """A single problem within a quiz."""
    title: str  # Required per-problem title, e.g. "Intro to Variables"
    problem_statement: str
    constraints: str = ""
    test_cases: str = ""
    starter_code: Dict[str, Any] = Field(default_factory=dict)
    # Per-problem survey config
    pre_survey_enabled: bool = True
    pre_survey: List[SurveyQuestionCreate] = Field(default_factory=list)
    post_survey_enabled: bool = True
    post_survey: List[SurveyQuestionCreate] = Field(default_factory=list)
    recurrent_survey_enabled: bool = True
    recurrent_survey: List[SurveyQuestionCreate] = Field(default_factory=list)
    recurrent_survey_interval: int = 4
    recurrent_survey_start: int = 5
    # Show recurrent questions in a collapsible side panel (opens when due, editor stays usable)
    recurrent_survey_side_panel: bool = False


# ─── Quiz Creation / Update ─────────────────────────────────────────────────

class QuizCreate(BaseModel):
    title: str
    description: str = ""
    problems: List[ProblemCreate] = Field(min_length=1)
    allowed_languages: List[str] = Field(default_factory=lambda: ["python", "javascript", "c"])
    time_limit_minutes: int = 0  # 0 = unlimited
    conditions: List[int] = Field(default_factory=lambda: [1])  # each must be 1, 2, or 3
    recurrent_survey: List[SurveyQuestionCreate] = Field(default_factory=list)
    recurrent_survey_interval: int = 4
    recurrent_survey_start: int = 5
    pre_survey: List[SurveyQuestionCreate] = Field(default_factory=list)
    post_survey: List[SurveyQuestionCreate] = Field(default_factory=list)
    published: bool = False
    availability_start: Optional[str] = None
    availability_end: Optional[str] = None
    paste_allowed: bool = True
    tab_tracking_enabled: bool = True


class QuizUpdate(BaseModel):
    """Partial update — all fields optional."""
    title: Optional[str] = None
    description: Optional[str] = None
    problems: Optional[List[ProblemCreate]] = None
    allowed_languages: Optional[List[str]] = None
    time_limit_minutes: Optional[int] = None
    conditions: Optional[List[int]] = None
    recurrent_survey: Optional[List[SurveyQuestionCreate]] = None
    recurrent_survey_interval: Optional[int] = None
    recurrent_survey_start: Optional[int] = None
    pre_survey: Optional[List[SurveyQuestionCreate]] = None
    post_survey: Optional[List[SurveyQuestionCreate]] = None
    published: Optional[bool] = None
    availability_start: Optional[str] = None
    availability_end: Optional[str] = None
    paste_allowed: Optional[bool] = None
    tab_tracking_enabled: Optional[bool] = None


# ─── Quiz Response (read) ───────────────────────────────────────────────────

class QuizSummary(BaseModel):
    """Lightweight quiz info for dashboard listing."""
    id: str
    title: str
    description: str = ""
    published: bool = False
    access_code: str = ""
    created_at: str = ""
    allowed_languages: List[str] = Field(default_factory=list)
    time_limit_minutes: int = 0
    conditions: List[int] = Field(default_factory=lambda: [1])
    problem_count: int = 1


# ─── Student quiz join ──────────────────────────────────────────────────────

class QuizJoinRequest(BaseModel):
    access_code: str
    user_id: str
    programming_language: str = "python"
