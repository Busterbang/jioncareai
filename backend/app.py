"""JointCare API: transparent motion summaries, not diagnosis."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import secrets
import time
import uuid
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from starlette.types import ASGIApp, Receive, Scope, Send

API_PREFIX = "/api/v1"
log = logging.getLogger("jointcare.ingest")
MAX_BATCH = 250
MAX_BODY_BYTES = 256_000


class ApiBodyLimitMiddleware:
    """Bound API request buffering even when a client omits Content-Length."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not str(scope.get("path", "")).startswith(API_PREFIX + "/"):
            await self.app(scope, receive, send)
            return
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        length = headers.get("content-length")
        if length:
            try:
                declared = int(length)
            except ValueError:
                await JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})(scope, receive, send)
                return
            if declared < 0:
                await JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})(scope, receive, send)
                return
            if declared > MAX_BODY_BYTES:
                await JSONResponse(status_code=413, content={"detail": "Request body exceeds 256 KB"})(scope, receive, send)
                return

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            body.extend(message.get("body", b""))
            if len(body) > MAX_BODY_BYTES:
                await JSONResponse(status_code=413, content={"detail": "Request body exceeds 256 KB"})(scope, receive, send)
                return
            if not message.get("more_body", False):
                break

        delivered = False

        async def replay_body() -> dict[str, Any]:
            nonlocal delivered
            if delivered:
                return {"type": "http.disconnect"}
            delivered = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay_body, send)


def device_token_digest(raw: str, secret: str) -> str:
    return hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest()


def resolve_device_auth_secret(candidate: str, service_role_key: str, public_keys: tuple[str, ...]) -> str:
    """Keep the device HMAC key independent of any browser-visible Supabase key."""
    candidate = candidate.strip()
    overlaps_public = any(candidate and public and (candidate in public or public in candidate) for public in public_keys)
    if len(candidate) >= 32 and not overlaps_public:
        return candidate
    root = service_role_key.strip()
    if len(root) < 32:
        raise RuntimeError("A server-only service-role key of at least 32 characters is required to derive device authentication")
    return hmac.new(root.encode(), b"JointCare AI device-token HMAC v1", hashlib.sha256).hexdigest()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    supabase_url: str = Field(default="", validation_alias=AliasChoices("SUPABASE_URL", "PUBLIC_SUPABASE_URL"))
    supabase_anon_key: str = Field(default="", validation_alias=AliasChoices("SUPABASE_ANON_KEY", "PUBLIC_SUPABASE_PUBLISHABLE_KEY", "PUBLIC_SUPABASE_ANON_KEY"))
    supabase_service_role_key: str = ""
    device_auth_secret: str = ""
    demo_mode: bool = False
    rate_limit_requests: int = Field(default=300, ge=1, le=10000)
    device_rate_limit_requests: int = Field(default=60, ge=1, le=10000)
    rate_limit_window_seconds: int = Field(default=60, ge=1, le=3600)

    def validate_ready(self) -> None:
        if self.demo_mode:
            return
        missing = [name for name, value in (("SUPABASE_URL", self.supabase_url), ("SUPABASE_ANON_KEY or PUBLIC_SUPABASE_PUBLISHABLE_KEY", self.supabase_anon_key), ("SUPABASE_SERVICE_ROLE_KEY", self.supabase_service_role_key)) if not value]
        if missing:
            raise RuntimeError("Missing required configuration: " + ", ".join(missing))
        if not self.supabase_url.startswith("https://"):
            raise RuntimeError("SUPABASE_URL must be an https URL")
        self.device_auth_secret = resolve_device_auth_secret(self.device_auth_secret, self.supabase_service_role_key, (self.supabase_anon_key,))


class Mode(str, Enum):
    real = "real"
    demo = "demo"


class Reading(BaseModel):
    model_config = ConfigDict(extra="forbid")
    measured_at: datetime
    accel_x: float = Field(ge=-200, le=200)
    accel_y: float = Field(ge=-200, le=200)
    accel_z: float = Field(ge=-200, le=200)
    gyro_x: float = Field(ge=-4000, le=4000)
    gyro_y: float = Field(ge=-4000, le=4000)
    gyro_z: float = Field(ge=-4000, le=4000)
    relative_angle_degrees: float | None = Field(default=None, ge=-180, le=180)

    @field_validator("measured_at")
    @classmethod
    def timestamp_tz(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("measured_at must include a timezone")
        return value


class ReadingsBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_token: str = Field(min_length=32, max_length=256)
    session_id: str
    readings: list[Reading] = Field(min_length=1, max_length=MAX_BATCH)


class SessionStart(BaseModel):
    mode: Mode = Mode.real
    device_id: str | None = None


class DeviceRegister(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_identifier: str = Field(min_length=1, max_length=128)


class SymptomInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    recorded_at: datetime
    joint: str = Field(min_length=1, max_length=80)
    pain_score: int = Field(ge=0, le=10)
    stiffness_score: int = Field(ge=0, le=10)
    swelling: bool
    discomfort: str | None = Field(default=None, max_length=500)
    activity: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("recorded_at")
    @classmethod
    def symptom_timestamp_tz(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("recorded_at must include a timezone")
        return value


class DeviceIngest(BaseModel):
    """Firmware payload. The token may be sent as `Authorization: Bearer` and/or `device_token`."""
    model_config = ConfigDict(extra="forbid")
    device_token: str | None = Field(default=None, min_length=32, max_length=256)
    device_identifier: str | None = Field(default=None, min_length=1, max_length=128)
    session_id: str
    readings: list[Reading] = Field(min_length=1, max_length=MAX_BATCH)


def resolve_device_token(authorization: str | None, body_token: str | None) -> str:
    """Accept the token from the Bearer header or body; if both are sent they must match."""
    header_token = ""
    if authorization and authorization.lower().startswith("bearer "):
        header_token = authorization.split(" ", 1)[1].strip()
    candidates = [t for t in (header_token, (body_token or "").strip()) if t]
    if not candidates:
        raise HTTPException(401, "Device token required: send it as 'Authorization: Bearer <token>' or in 'device_token'.", headers={"WWW-Authenticate": "Bearer"})
    if len(candidates) == 2 and not hmac.compare_digest(candidates[0].encode(), candidates[1].encode()):
        raise HTTPException(401, "Authorization header token and body device_token do not match.")
    token = candidates[0]
    if not 32 <= len(token) <= 256:
        raise HTTPException(401, "Malformed device token. Re-enroll or rotate the token and copy it exactly.")
    return token


class Supabase:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = httpx.AsyncClient(timeout=10.0)
        self.base = settings.supabase_url.rstrip("/")

    async def request(self, method: str, path: str, *, token: str, service: bool = False, **kwargs: Any) -> Any:
        key = self.settings.supabase_service_role_key if service else self.settings.supabase_anon_key
        headers = {"apikey": key, "Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        preferences: list[str] = []
        if kwargs.pop("prefer_ignore_duplicates", False):
            preferences.extend(("resolution=ignore-duplicates", "return=minimal"))
        if kwargs.pop("prefer_representation", False):
            preferences.append("return=representation")
        if preferences:
            headers["Prefer"] = ", ".join(preferences)
        response = await self.client.request(method, f"{self.base}{path}", headers=headers, **kwargs)
        if response.status_code >= 400:
            log.warning("supabase_error method=%s path=%s http=%s", method, path.split("?")[0], response.status_code)
            try:
                error_body = response.json()
            except ValueError:
                error_body = {}
            error_code = error_body.get("code") if isinstance(error_body, dict) else None
            if error_code in {"PGRST204", "PGRST205", "42P01", "42703"}:
                raise HTTPException(503, "JointCare's Supabase schema is missing or out of date. Apply the SQL migrations in supabase/SETUP.md, then retry.")
            if error_code == "23503":
                raise HTTPException(409, "A required patient profile or linked record is missing. Retry device enrollment after profile repair.")
            if error_code == "23505" and path.startswith("/rest/v1/sensor_devices"):
                raise HTTPException(409, "That device identifier is already in use. Choose a unique identifier and retry.")
            if response.status_code == 404:
                raise HTTPException(404, "Requested record was not found")
            if response.status_code == 429:
                raise HTTPException(429, "Upstream rate limit exceeded")
            if response.status_code in (401, 403):
                raise HTTPException(response.status_code, "Not authorized for this operation")
            raise HTTPException(502, "Supabase request failed")
        if not response.content:
            return None
        return response.json()

    async def close(self) -> None:
        await self.client.aclose()


def analyze_trend(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Summarize observed movement only; never infer disease or inflammation."""
    values: list[float] = []
    timed_values: list[tuple[datetime, float]] = []
    grouped_samples: dict[str, list[tuple[datetime, float]]] = {}
    for row in rows:
        value = row.get("relative_angle_degrees")
        if isinstance(value, (float, int)) and math.isfinite(value):
            values.append(float(value))
            timestamp = row.get("measured_at")
            if timestamp:
                try:
                    measured_at = timestamp if isinstance(timestamp, datetime) else datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
                    if measured_at.tzinfo is not None:
                        session = str(row.get("session_id") or "unassigned")
                        grouped_samples.setdefault(session, []).append((measured_at, float(value)))
                        timed_values.append((measured_at, float(value)))
                except ValueError:
                    pass
    n = len(rows)
    if not n:
        return {"summary": "No movement samples available for this period.", "metrics": {"samples": 0, "angle_samples": 0}, "quality": {"status": "missing", "missing_angle_samples": 0, "within_session_gaps_over_60s": 0, "large_angle_steps_over_90deg": 0}}
    mean = round(sum(values) / len(values), 2) if values else None
    span = round(max(values) - min(values), 2) if values else None
    ordered_values = [value for _at, value in sorted(timed_values, key=lambda sample: sample[0])] if len(timed_values) >= 2 else values
    missing = n - len(values)
    metrics: dict[str, Any] = {"samples": n, "angle_samples": len(values), "mean_relative_angle_degrees": mean, "observed_angle_span_degrees": span}
    gap_count = 0
    large_step_count = 0
    for samples in grouped_samples.values():
        ordered = sorted(samples, key=lambda sample: sample[0])
        for (earlier_at, earlier_angle), (later_at, later_angle) in zip(ordered, ordered[1:]):
            gap_seconds = (later_at - earlier_at).total_seconds()
            if gap_seconds > 60:
                gap_count += 1
            elif 0 < gap_seconds <= 60 and abs(later_angle - earlier_angle) >= 90:
                large_step_count += 1
    quality = "missing" if not values else ("partial" if missing else ("review" if gap_count or large_step_count else "good"))
    label = "Movement measurements were observed" if values else "Movement samples were received, but relative-angle measurements are missing"
    warnings = []
    if missing:
        warnings.append(f"{missing} samples have no usable relative angle")
    if gap_count:
        warnings.append(f"{gap_count} within-session gaps exceed 60 seconds")
    if large_step_count:
        warnings.append(f"{large_step_count} adjacent relative-angle changes are 90° or greater; verify mounting and signal continuity")
    summary = label + ". This is a relative measurement, not a clinical range or diagnosis."
    if len(ordered_values) >= 4:
        midpoint = len(ordered_values) // 2
        earlier_mean = sum(ordered_values[:midpoint]) / midpoint
        later_mean = sum(ordered_values[midpoint:]) / (len(ordered_values) - midpoint)
        difference = later_mean - earlier_mean
        metrics.update({"earlier_half_mean_relative_angle_degrees": round(earlier_mean, 2), "later_half_mean_relative_angle_degrees": round(later_mean, 2), "later_minus_earlier_mean_degrees": round(difference, 2)})
        summary += f" Across the earlier and later halves of observed samples, the mean relative angle differed by {difference:+.2f}°. Sensor orientation and placement may contribute to this descriptive difference."
    if warnings:
        summary += " Data-quality review: " + "; ".join(warnings) + "."
    return {"summary": summary, "metrics": metrics, "quality": {"status": quality, "missing_angle_samples": missing, "within_session_gaps_over_60s": gap_count, "large_angle_steps_over_90deg": large_step_count}}


def analyze_patient_trends(readings: list[dict[str, Any]], symptoms: list[dict[str, Any]]) -> dict[str, Any]:
    """Describe paired daily angle/pain/stiffness observations without clinical inference."""
    result = analyze_trend(readings)
    daily: dict[str, dict[str, list[float]]] = {}
    for reading in readings:
        value = reading.get("relative_angle_degrees")
        if not isinstance(value, (float, int)) or not math.isfinite(value):
            continue
        day = str(reading.get("measured_at", ""))[:10]
        if len(day) == 10:
            daily.setdefault(day, {"angles": [], "pain": [], "stiffness": []})["angles"].append(float(value))
    for symptom in symptoms:
        day = str(symptom.get("recorded_at", ""))[:10]
        if len(day) != 10:
            continue
        group = daily.setdefault(day, {"angles": [], "pain": [], "stiffness": []})
        for field in ("pain_score", "stiffness_score"):
            score = symptom.get(field)
            if isinstance(score, (float, int)) and math.isfinite(score):
                group["pain" if field == "pain_score" else "stiffness"].append(float(score))

    metrics = result["metrics"]
    metrics["pain_angle_pair_days"] = sum(bool(day["angles"] and day["pain"]) for day in daily.values())
    metrics["stiffness_angle_pair_days"] = sum(bool(day["angles"] and day["stiffness"]) for day in daily.values())
    sentences: list[str] = []
    for label in ("pain", "stiffness"):
        pairs = [(sum(group["angles"]) / len(group["angles"]), sum(group[label]) / len(group[label])) for group in daily.values() if group["angles"] and group[label]]
        if len(pairs) < 3:
            continue
        mean_angle = sum(pair[0] for pair in pairs) / len(pairs)
        mean_score = sum(pair[1] for pair in pairs) / len(pairs)
        numerator = sum((angle - mean_angle) * (score - mean_score) for angle, score in pairs)
        denominator_angle = math.sqrt(sum((angle - mean_angle) ** 2 for angle, _score in pairs))
        denominator_score = math.sqrt(sum((score - mean_score) ** 2 for _angle, score in pairs))
        if denominator_angle > 0 and denominator_score > 0:
            coefficient = numerator / (denominator_angle * denominator_score)
            metrics[f"{label}_angle_association_r"] = round(coefficient, 3)
            sentences.append(f"Across {len(pairs)} dates with both records, the descriptive daily {label}/angle association was r={coefficient:.2f}; it does not establish cause or clinical meaning.")
        else:
            sentences.append(f"Movement and {label} records overlap on {len(pairs)} dates, but there is not enough variation for a numerical association.")
    if not sentences and symptoms:
        sentences.append("Too few dates contain both movement and symptom records for a paired trend comparison.")
    if sentences:
        result["summary"] += " " + " ".join(sentences)
    result["summary"] += " Interpret cautiously: sample count, missingness, sensor placement and stationary reference calibration limit comparisons."
    return result


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or Settings()
    sb: Supabase | None = None
    rate_buckets: dict[str, deque[float]] = {}

    @asynccontextmanager
    async def lifespan(api: FastAPI) -> AsyncIterator[None]:
        nonlocal sb
        try:
            cfg.validate_ready()
        except RuntimeError as exc:
            api.state.readiness_error = str(exc)
        else:
            sb = Supabase(cfg)
            api.state.readiness_error = None
        try:
            yield
        finally:
            if sb:
                await sb.close()

    api = FastAPI(title="JointCare API", version="1.0.0", description="Patient-controlled sensor and symptom records with non-diagnostic trend summaries.", lifespan=lifespan)
    api.add_middleware(ApiBodyLimitMiddleware)

    @api.middleware("http")
    async def enforce_api_rate_limit(request: Request, call_next):
        if not request.url.path.startswith(API_PREFIX + "/"):
            return await call_next(request)
        authorization = request.headers.get("authorization", "")
        identity = hashlib.sha256(authorization.encode()).hexdigest()[:20] if authorization else (request.client.host if request.client else "unknown")
        bucket_key = f"{request.url.path.rsplit('/', 1)[0]}:{identity}"
        now = time.monotonic()
        window = cfg.rate_limit_window_seconds
        bucket = rate_buckets.setdefault(bucket_key, deque())
        while bucket and now - bucket[0] >= window:
            bucket.popleft()
        limit = cfg.device_rate_limit_requests if request.url.path.endswith("/sensor/devices/ingest") else cfg.rate_limit_requests
        if len(bucket) >= limit:
            retry_after = max(1, int(window - (now - bucket[0])))
            return JSONResponse(status_code=429, content={"detail": "Request rate limit exceeded; retry shortly."}, headers={"Retry-After": str(retry_after)})
        bucket.append(now)
        if len(rate_buckets) > 4096:
            for stale_key, stale_bucket in tuple(rate_buckets.items()):
                if not stale_bucket or now - stale_bucket[-1] >= window:
                    rate_buckets.pop(stale_key, None)
            while len(rate_buckets) > 4096:
                rate_buckets.pop(next(iter(rate_buckets)))
        return await call_next(request)

    async def require_sb() -> Supabase:
        if sb is None:
            raise HTTPException(503, "Backend is not ready; configure Supabase or enable demo mode")
        return sb

    async def user_context(authorization: str | None = Header(default=None), db: Supabase = Depends(require_sb)) -> dict[str, str]:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "Bearer user token required", headers={"WWW-Authenticate": "Bearer"})
        token = authorization.split(" ", 1)[1].strip()
        if not token:
            raise HTTPException(401, "Bearer user token required")
        try:
            profile = await db.request("GET", "/auth/v1/user", token=token)
        except HTTPException as exc:
            raise HTTPException(401, "Invalid or expired user token", headers={"WWW-Authenticate": "Bearer"}) from exc
        if not profile or not profile.get("id"):
            raise HTTPException(401, "Invalid user token")
        return {"id": str(profile["id"]), "token": token}

    async def ensure_patient_profile(user_id: str, db: Supabase) -> None:
        # The user ID comes from Supabase Auth. Ignore conflicts so an existing clinician/admin role is never overwritten.
        await db.request(
            "POST",
            "/rest/v1/profiles?on_conflict=id",
            token=cfg.supabase_service_role_key,
            service=True,
            prefer_ignore_duplicates=True,
            json={"id": user_id, "role": "patient"},
        )
        profiles = await db.request(
            "GET",
            f"/rest/v1/profiles?id=eq.{quote(user_id)}&select=role",
            token=cfg.supabase_service_role_key,
            service=True,
        )
        if not profiles:
            raise HTTPException(503, "JointCare could not initialize your patient profile. Apply the Supabase migrations and retry.")
        if profiles[0].get("role") != "patient":
            raise HTTPException(403, "Only patient accounts can enroll sensor devices.")

    @api.get("/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "service": "jointcare-api"}

    @api.get("/healthz")
    async def hosted_health() -> dict[str, str]:
        return {"status": "ok"}

    @api.get("/jointcare-config.js", include_in_schema=False)
    async def browser_safe_config() -> Response:
        public_config = json.dumps({"supabaseUrl": cfg.supabase_url, "publishableKey": cfg.supabase_anon_key})
        return Response(content=f"window.__JOINTCARE_RUNTIME__ = {public_config};", media_type="application/javascript", headers={"Cache-Control": "no-store"})

    @api.get("/ready")
    async def ready() -> dict[str, Any]:
        if sb is None:
            raise HTTPException(503, getattr(api.state, "readiness_error", "Supabase is not configured"))
        return {"status": "ready", "demo_mode": cfg.demo_mode}

    @api.post(API_PREFIX + "/sensor/devices/register", status_code=201)
    async def register_device(payload: DeviceRegister, ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> dict[str, Any]:
        # Enrollment uses the service role only after validating the patient's own Supabase Auth token.
        await ensure_patient_profile(ctx["id"], db)
        raw = secrets.token_urlsafe(48)
        digest = device_token_digest(raw, cfg.device_auth_secret)
        rows = await db.request("POST", "/rest/v1/sensor_devices", token=cfg.supabase_service_role_key, service=True, prefer_representation=True, json={"patient_id": ctx["id"], "device_identifier": payload.device_identifier, "access_token_hash": digest, "is_active": True, "status": "active"})
        if not rows:
            raise HTTPException(502, "Device enrollment returned no record")
        return {"device": rows[0], "device_token": raw, "token_notice": "Store securely: the token is shown once and cannot be retrieved."}

    @api.post(API_PREFIX + "/sensor/devices/rotate-token")
    async def rotate_device_token(payload: DeviceRegister, ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> dict[str, Any]:
        """Issue a fresh token for an EXISTING device row owned by this patient (keeps its identifier/UUID)."""
        rows = await db.request("GET", f"/rest/v1/sensor_devices?device_identifier=eq.{quote(payload.device_identifier)}&patient_id=eq.{quote(ctx['id'])}&select=id,device_identifier", token=cfg.supabase_service_role_key, service=True)
        if not rows:
            raise HTTPException(404, "No device with that identifier belongs to this patient")
        raw = secrets.token_urlsafe(48)
        updated = await db.request("PATCH", f"/rest/v1/sensor_devices?id=eq.{quote(str(rows[0]['id']))}&patient_id=eq.{quote(ctx['id'])}", token=cfg.supabase_service_role_key, service=True, prefer_representation=True, json={"access_token_hash": device_token_digest(raw, cfg.device_auth_secret), "is_active": True, "status": "active"})
        if not updated:
            raise HTTPException(502, "Token rotation returned no record")
        log.info("device_token_rotated device=%s patient=%s", rows[0]["id"], ctx["id"])
        d = updated[0]
        return {"device": {k: d.get(k) for k in ("id", "device_identifier", "is_active", "status")}, "device_token": raw, "token_notice": "Store securely: the token is shown once. The previous token no longer works."}

    @api.post(API_PREFIX + "/sensor/sessions/start", status_code=201)
    async def start_session(payload: SessionStart, ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> Any:
        if payload.mode is not Mode.real:
            raise HTTPException(400, "Simulated sessions are local-only and are never persisted to patient records")
        if not payload.device_id:
            raise HTTPException(400, "An enrolled hardware device is required for a real session")
        record = {"patient_id": ctx["id"], "mode": payload.mode.value, "status": "active", "started_at": datetime.now(timezone.utc).isoformat()}
        # sensor_devices intentionally has no authenticated-client SELECT policy. Verify by UUID
        # under service role, but always scope the query to the Auth-verified patient ID.
        devices = await db.request(
            "GET",
            f"/rest/v1/sensor_devices?id=eq.{quote(payload.device_id)}&patient_id=eq.{quote(ctx['id'])}&is_active=eq.true&status=eq.active&select=id",
            token=cfg.supabase_service_role_key,
            service=True,
        )
        if not devices:
            raise HTTPException(403, "Device is not active or does not belong to this patient")
        record["device_id"] = payload.device_id
        rows = await db.request("POST", "/rest/v1/monitoring_sessions", token=ctx["token"], prefer_representation=True, json=record)
        return rows[0] if rows else {}

    @api.post(API_PREFIX + "/sensor/sessions/stop")
    async def stop_session(session_id: str = Query(...), ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> Any:
        rows = await db.request("PATCH", f"/rest/v1/monitoring_sessions?id=eq.{quote(session_id)}&patient_id=eq.{quote(ctx['id'])}&status=in.(active,paused)", token=ctx["token"], prefer_representation=True, json={"status": "completed", "ended_at": datetime.now(timezone.utc).isoformat()})
        if not rows:
            raise HTTPException(404, "Active session not found for this patient")
        return rows[0]

    @api.post(API_PREFIX + "/sensor/sessions/pause")
    async def pause_session(session_id: str = Query(...), ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> Any:
        rows = await db.request("PATCH", f"/rest/v1/monitoring_sessions?id=eq.{quote(session_id)}&patient_id=eq.{quote(ctx['id'])}&status=eq.active", token=ctx["token"], prefer_representation=True, json={"status": "paused"})
        if not rows:
            raise HTTPException(404, "Active session not found for this patient")
        return rows[0]

    @api.post(API_PREFIX + "/sensor/sessions/resume")
    async def resume_session(session_id: str = Query(...), ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> Any:
        rows = await db.request("PATCH", f"/rest/v1/monitoring_sessions?id=eq.{quote(session_id)}&patient_id=eq.{quote(ctx['id'])}&status=eq.paused", token=ctx["token"], prefer_representation=True, json={"status": "active"})
        if not rows:
            raise HTTPException(404, "Paused session not found for this patient")
        return rows[0]

    @api.get(API_PREFIX + "/sensor/sessions/{session_id}")
    async def get_session(session_id: str, ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> Any:
        rows = await db.request("GET", f"/rest/v1/monitoring_sessions?id=eq.{quote(session_id)}&patient_id=eq.{quote(ctx['id'])}&select=*", token=ctx["token"])
        if not rows:
            raise HTTPException(404, "Session not found")
        return rows[0]

    @api.get(API_PREFIX + "/sensor/devices/status")
    async def device_status(ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> Any:
        # Expose only this authenticated patient's active devices; never query this table as an
        # unfiltered service-role list or rely on a nonexistent client-side RLS policy.
        return await db.request(
            "GET",
            f"/rest/v1/sensor_devices?patient_id=eq.{quote(ctx['id'])}&is_active=eq.true&status=eq.active&select=id,device_identifier,is_active,status,last_seen_at",
            token=cfg.supabase_service_role_key,
            service=True,
        )

    @api.post(API_PREFIX + "/sensor/readings", status_code=201)
    async def ingest(payload: ReadingsBatch, ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> dict[str, Any]:
        return await _ingest(payload, ctx, db, cfg)

    @api.post(API_PREFIX + "/sensor/devices/ingest", status_code=201)
    async def device_ingest(payload: DeviceIngest, authorization: str | None = Header(default=None), db: Supabase = Depends(require_sb)) -> dict[str, Any]:
        token = resolve_device_token(authorization, payload.device_token)
        _require_uuid(payload.session_id)
        return await _ingest(payload, None, db, cfg, raw_token=token)

    @api.post(API_PREFIX + "/symptoms", status_code=201)
    async def add_symptom(payload: SymptomInput, ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> Any:
        record = payload.model_dump(mode="json") | {"patient_id": ctx["id"], "source": "patient"}
        rows = await db.request("POST", "/rest/v1/symptom_records", token=ctx["token"], prefer_representation=True, json=record)
        return rows[0] if rows else {}

    @api.get(API_PREFIX + "/analytics/trends")
    async def trends(days: int = Query(default=30, ge=1, le=365), ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> dict[str, Any]:
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days)
        since = start.isoformat()
        rows = await db.request("GET", f"/rest/v1/sensor_readings?patient_id=eq.{quote(ctx['id'])}&measured_at=gte.{quote(since)}&select=session_id,relative_angle_degrees,measured_at&order=measured_at.asc&limit=10000", token=ctx["token"])
        symptoms = await db.request("GET", f"/rest/v1/symptom_records?patient_id=eq.{quote(ctx['id'])}&recorded_at=gte.{quote(since)}&select=recorded_at,pain_score,stiffness_score&order=recorded_at.asc&limit=1000", token=ctx["token"])
        return {"period_days": days, "analysis": analyze_patient_trends(rows, symptoms), "source": "observed_patient_records", "disclaimer": "Descriptive movement/symptom comparison only. Relative angle is not a clinical range; this does not diagnose disease or inflammation or recommend medication."}

    @api.post(API_PREFIX + "/analytics/generate", status_code=201)
    async def generate_analysis(days: int = Query(default=30, ge=1, le=365), ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> dict[str, Any]:
        end = datetime.now(timezone.utc)
        start = end - timedelta(days=days)
        since = start.isoformat()
        readings = await db.request("GET", f"/rest/v1/sensor_readings?patient_id=eq.{quote(ctx['id'])}&measured_at=gte.{quote(since)}&select=session_id,relative_angle_degrees,measured_at&order=measured_at.asc&limit=10000", token=ctx["token"])
        symptoms = await db.request("GET", f"/rest/v1/symptom_records?patient_id=eq.{quote(ctx['id'])}&recorded_at=gte.{quote(since)}&select=recorded_at,pain_score,stiffness_score&order=recorded_at.asc&limit=1000", token=ctx["token"])
        analysis = analyze_patient_trends(readings, symptoms)
        record = {"patient_id": ctx["id"], "window_start": start.isoformat(), "window_end": end.isoformat(), "summary": analysis["summary"], "metrics": analysis["metrics"], "quality": analysis["quality"], "source": "rule_based", "model_version": "jointcare-rules-v1"}
        saved = await db.request("POST", "/rest/v1/analysis_results", token=cfg.supabase_service_role_key, service=True, prefer_representation=True, json=record)
        return saved[0] if saved else record | {"generated_at": end.isoformat()}

    @api.post(API_PREFIX + "/demo/sample")
    async def demo_sample() -> dict[str, Any]:
        if not cfg.demo_mode:
            raise HTTPException(404, "Demo sample generation is disabled")
        now = datetime.now(timezone.utc).isoformat()
        rows = [{"measured_at": now, "relative_angle_degrees": round(18 + 4 * math.sin(i / 4), 2)} for i in range(12)]
        return {"demo": True, "source": "simulated_demo_only", "analysis": analyze_trend(rows), "readings": rows, "persisted": False}

    @api.delete(API_PREFIX + "/account", status_code=204)
    async def delete_account(ctx: dict = Depends(user_context), db: Supabase = Depends(require_sb)) -> Response:
        # Supabase Auth cascades the profile FK and the app's dependent records.
        await db.request("DELETE", f"/auth/v1/admin/users/{quote(ctx['id'])}", token=cfg.supabase_service_role_key, service=True)
        return Response(status_code=204)

    @api.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        # Default FastAPI errors echo the submitted `input`, which could include a device token.
        issues = [{"field": ".".join(str(p) for p in e.get("loc", ()) if p != "body"), "problem": e.get("msg", "invalid")} for e in exc.errors()[:10]]
        return JSONResponse(status_code=422, content={"detail": "Request body failed validation", "errors": issues})

    @api.exception_handler(Exception)
    async def internal_error(_request: Request, _exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=500, content={"detail": "Internal server error"})

    frontend_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
    if frontend_dist.is_dir():
        index_file = frontend_dist / "index.html"

        @api.get("/", include_in_schema=False)
        async def frontend_index() -> FileResponse:
            return FileResponse(index_file)

        @api.get("/{client_path:path}", include_in_schema=False)
        async def frontend_route(client_path: str) -> FileResponse:
            if client_path.startswith(("api/", "health")):
                raise HTTPException(404, "Not found")
            target = (frontend_dist / client_path).resolve()
            if frontend_dist.resolve() not in target.parents:
                raise HTTPException(404, "Not found")
            if target.is_file():
                return FileResponse(target)
            if index_file.is_file():
                return FileResponse(index_file)
            raise HTTPException(404, "Not found")

    return api


def _require_uuid(value: str) -> None:
    try:
        uuid.UUID(value)
    except ValueError:
        raise HTTPException(422, "session_id must be the UUID shown as 'Active session ID' in the dashboard") from None


def _reject(code: int, reason: str, detail: str, **fields: Any) -> HTTPException:
    """Log a server-side diagnostic (ids only: never tokens, digests or keys) and build the HTTP error."""
    log.warning("ingest_rejected reason=%s http=%s %s", reason, code, " ".join(f"{k}={v}" for k, v in fields.items()))
    return HTTPException(code, detail)


async def _ingest(payload: ReadingsBatch | DeviceIngest, ctx: dict | None, db: Supabase, cfg: Settings, raw_token: str | None = None) -> dict[str, Any]:
    token = raw_token or payload.device_token or ""
    digest = device_token_digest(token, cfg.device_auth_secret)
    devices = await db.request("GET", f"/rest/v1/sensor_devices?access_token_hash=eq.{digest}&select=id,patient_id,device_identifier,is_active,status,access_token_hash", token=cfg.supabase_service_role_key, service=True)
    device = devices[0] if devices else None
    if not device or not hmac.compare_digest(str(device.get("access_token_hash", "")).encode(), digest.encode()):
        raise _reject(401, "unknown_token", "Invalid device token. If this device was created outside the app, call POST /api/v1/sensor/devices/rotate-token (signed in as the patient) and copy the new token into secrets.h.")
    ids = {"device": device["id"], "patient": device["patient_id"], "session": payload.session_id}
    if ctx is not None and str(device["patient_id"]) != ctx["id"]:
        raise _reject(403, "patient_mismatch", "Device does not belong to authenticated patient", **ids)
    if device.get("is_active") is not True or device.get("status") != "active":
        raise _reject(403, "device_inactive", f"Device is not active (status={device.get('status')}). Re-enable or re-enroll it from the dashboard.", **ids, status=device.get("status"))
    claimed = getattr(payload, "device_identifier", None)
    if claimed and claimed != device.get("device_identifier"):
        raise _reject(403, "identifier_mismatch", "device_identifier does not match the device that owns this token. Set DEVICE_ID in secrets.h to the enrolled identifier.", **ids)
    sess = await db.request("GET", f"/rest/v1/monitoring_sessions?id=eq.{quote(payload.session_id)}&device_id=eq.{quote(str(device['id']))}&patient_id=eq.{quote(str(device['patient_id']))}&select=id,status,mode", token=cfg.supabase_service_role_key, service=True)
    if not sess:
        raise _reject(404, "session_not_found", "Session not found for this device. Start a session for THIS device in the dashboard and copy its ID into SESSION_ID.", **ids)
    if sess[0].get("mode") != "real":
        raise _reject(403, "session_not_real", "Only real-hardware sessions accept device telemetry.", **ids)
    if sess[0].get("status") != "active":
        raise _reject(409, "session_not_active", f"Session is {sess[0].get('status')}, not active. Start or resume it in the dashboard and update SESSION_ID.", **ids)
    inserts = [r.model_dump(mode="json") | {"session_id": payload.session_id, "patient_id": device["patient_id"], "device_id": device["id"], "source": "device"} for r in payload.readings]
    await db.request("POST", "/rest/v1/sensor_readings", token=cfg.supabase_service_role_key, service=True, json=inserts)
    # Only after readings are stored is the device considered seen; status is deliberately not rewritten.
    await db.request("PATCH", f"/rest/v1/sensor_devices?id=eq.{quote(str(device['id']))}", token=cfg.supabase_service_role_key, service=True, json={"last_seen_at": datetime.now(timezone.utc).isoformat()})
    log.info("ingest_accepted device=%s patient=%s session=%s count=%s", device["id"], device["patient_id"], payload.session_id, len(inserts))
    return {"accepted": len(inserts), "session_id": payload.session_id}


app = create_app()
