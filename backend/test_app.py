from datetime import datetime, timezone
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app as jointcare_api
from app import DeviceIngest, Reading, ReadingsBatch, Settings, _ingest, analyze_patient_trends, analyze_trend, create_app, device_token_digest, resolve_device_auth_secret


def test_existing_auth_users_receive_missing_patient_profiles_without_overwrites():
    project_root = Path(__file__).resolve().parents[1]
    migration = (project_root / "supabase/migrations/20261027010000_jointcare_existing_user_profile_backfill.sql").read_text(encoding="utf-8").lower()
    assert "insert into public.profiles" in migration
    assert "from auth.users" in migration
    assert "'patient'" in migration
    assert "on conflict (id) do nothing" in migration


def test_device_auth_never_uses_a_browser_visible_public_key():
    public_key = "sb_publishable_fake_012345678901234567890123456789"
    service_role = "server-only-service-role-test-01234567890123456789"
    derived = resolve_device_auth_secret(public_key, service_role, (public_key,))
    assert derived != public_key
    assert derived != service_role
    assert derived == resolve_device_auth_secret("", service_role, (public_key,))
    assert resolve_device_auth_secret("private-device-secret-12345678901234567890", service_role, (public_key,)) == "private-device-secret-12345678901234567890"


def test_reading_requires_timezone_and_rejects_out_of_range():
    with pytest.raises(ValidationError):
        Reading.model_validate({"measured_at": "2026-01-01T00:00:00", "accel_x": 0, "accel_y": 0, "accel_z": 0, "gyro_x": 0, "gyro_y": 0, "gyro_z": 0})
    with pytest.raises(ValidationError):
        Reading.model_validate({"measured_at": datetime.now(timezone.utc), "accel_x": 201, "accel_y": 0, "accel_z": 0, "gyro_x": 0, "gyro_y": 0, "gyro_z": 0})
    with pytest.raises(ValidationError):
        Reading.model_validate({"measured_at": datetime.now(timezone.utc), "accel_x": 0, "accel_y": 0, "accel_z": 0, "gyro_x": 0, "gyro_y": 0, "gyro_z": 0, "relative_angle_degrees": 181})


def test_batch_limit_is_250():
    row = dict(measured_at=datetime.now(timezone.utc), accel_x=0, accel_y=0, accel_z=0, gyro_x=0, gyro_y=0, gyro_z=0)
    with pytest.raises(ValidationError):
        ReadingsBatch.model_validate({"device_token": "x" * 40, "session_id": "session", "readings": [row] * 251})
    assert len(DeviceIngest.model_validate({"device_token": "x" * 40, "session_id": "session", "readings": [row] * 250}).readings) == 250


def test_analytics_reports_partial_missing_data_and_non_diagnostic_language():
    result = analyze_trend([{"relative_angle_degrees": 10}, {"relative_angle_degrees": None}, {}])
    assert result["quality"]["status"] == "partial"
    assert result["quality"]["missing_angle_samples"] == 2
    assert result["metrics"]["observed_angle_span_degrees"] == 0
    assert "not a clinical range" in result["summary"]


def test_analytics_empty_data_is_missing():
    assert analyze_trend([])["quality"]["status"] == "missing"


def test_analytics_marks_large_relative_step_and_long_within_session_gap():
    result = analyze_trend([
        {"session_id": "s1", "measured_at": "2026-10-27T10:00:00+00:00", "relative_angle_degrees": 0},
        {"session_id": "s1", "measured_at": "2026-10-27T10:00:01+00:00", "relative_angle_degrees": 95},
        {"session_id": "s1", "measured_at": "2026-10-27T10:02:02+00:00", "relative_angle_degrees": 100},
    ])
    assert result["quality"]["status"] == "review"
    assert result["quality"]["large_angle_steps_over_90deg"] == 1
    assert result["quality"]["within_session_gaps_over_60s"] == 1
    assert "verify mounting" in result["summary"]


def test_demo_is_explicitly_simulated_and_never_persisted():
    app = create_app(Settings(demo_mode=True))
    with TestClient(app) as client:
        response = client.post("/api/v1/demo/sample")
        assert response.status_code == 200
        body = response.json()
        assert body["demo"] is True
        assert body["source"] == "simulated_demo_only"
        assert body["persisted"] is False
        assert len(body["readings"]) == 12


def test_not_ready_routes_fail_cleanly_without_credentials():
    app = create_app(Settings(supabase_url="", supabase_anon_key="", supabase_service_role_key="", device_auth_secret=""))
    with TestClient(app) as client:
        assert client.get("/ready").status_code == 503
        assert client.get("/health").status_code == 200
        response = client.get("/api/v1/sensor/devices/status")
        assert response.status_code == 503
        assert "not ready" in response.json()["detail"].lower()


def test_device_enrollment_repairs_missing_patient_profile_before_insert(monkeypatch):
    created = []

    class FakeSupabase:
        def __init__(self, _settings):
            self.calls = []
            created.append(self)

        async def request(self, method, path, **kwargs):
            self.calls.append({"method": method, "path": path, **kwargs})
            if path == "/auth/v1/user":
                return {"id": "patient-1"}
            if method == "POST" and path == "/rest/v1/profiles?on_conflict=id":
                return None
            if method == "GET" and path.startswith("/rest/v1/profiles?"):
                return [{"role": "patient"}]
            if method == "POST" and path == "/rest/v1/sensor_devices":
                return [{"id": "device-1", "device_identifier": kwargs["json"]["device_identifier"]}]
            raise AssertionError(f"Unexpected request: {method} {path}")

        async def close(self):
            return None

    monkeypatch.setattr(jointcare_api, "Supabase", FakeSupabase)
    service_key = "server-only-service-role-test-01234567890123456789"
    settings = Settings(supabase_url="https://example.supabase.co", supabase_anon_key="publishable-test", supabase_service_role_key=service_key, device_auth_secret="device-secret-test-1234567890123456")
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/v1/sensor/devices/register", json={"device_identifier": "esp32"}, headers={"Authorization": "Bearer patient-access-token"})

    assert response.status_code == 201
    body = response.json()
    assert body["device"]["id"] == "device-1"
    assert len(body["device_token"]) >= 32
    calls = created[0].calls
    profile_insert = next(call for call in calls if call["path"] == "/rest/v1/profiles?on_conflict=id")
    assert profile_insert["json"] == {"id": "patient-1", "role": "patient"}
    assert profile_insert["token"] == service_key and profile_insert["service"] is True
    assert profile_insert["prefer_ignore_duplicates"] is True
    role_check_index = next(i for i, call in enumerate(calls) if call["method"] == "GET" and call["path"].startswith("/rest/v1/profiles?"))
    device_insert_index = next(i for i, call in enumerate(calls) if call["path"] == "/rest/v1/sensor_devices")
    assert role_check_index < device_insert_index


def test_device_enrollment_does_not_promote_or_accept_clinician_profiles(monkeypatch):
    calls = []

    class FakeSupabase:
        def __init__(self, _settings):
            pass

        async def request(self, method, path, **kwargs):
            calls.append({"method": method, "path": path, **kwargs})
            if path == "/auth/v1/user":
                return {"id": "clinician-1"}
            if path == "/rest/v1/profiles?on_conflict=id":
                return None
            if path.startswith("/rest/v1/profiles?"):
                return [{"role": "clinician"}]
            raise AssertionError(f"Unexpected request: {method} {path}")

        async def close(self):
            return None

    monkeypatch.setattr(jointcare_api, "Supabase", FakeSupabase)
    settings = Settings(supabase_url="https://example.supabase.co", supabase_anon_key="publishable-test", supabase_service_role_key="server-only-service-role-test-01234567890123456789", device_auth_secret="device-secret-test-1234567890123456")
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/v1/sensor/devices/register", json={"device_identifier": "esp32"}, headers={"Authorization": "Bearer clinician-access-token"})

    assert response.status_code == 403
    assert "patient accounts" in response.json()["detail"].lower()
    assert not any(call["path"] == "/rest/v1/sensor_devices" for call in calls)


def test_supabase_device_conflicts_return_actionable_safe_errors(monkeypatch):
    import asyncio
    from fastapi import HTTPException

    class FakeResponse:
        status_code = 409
        content = b'{"code":"23505","details":"private row values omitted","message":"duplicate key"}'

        def json(self):
            return {"code": "23505", "details": "private row values omitted", "message": "duplicate key"}

    async def fake_request(*_args, **_kwargs):
        return FakeResponse()

    database = jointcare_api.Supabase(Settings(supabase_url="https://example.supabase.co", supabase_anon_key="publishable-test", supabase_service_role_key="server-only-service-role-test-01234567890123456789"))
    monkeypatch.setattr(database.client, "request", fake_request)
    try:
        with pytest.raises(HTTPException) as error:
            asyncio.run(database.request("POST", "/rest/v1/sensor_devices", token="server-only-service-role-test", service=True, json={}))
        assert error.value.status_code == 409
        assert "unique identifier" in error.value.detail.lower()
        assert "private row values" not in error.value.detail.lower()
    finally:
        asyncio.run(database.close())


def test_demo_endpoint_disabled_by_default():
    app = create_app(Settings())
    with TestClient(app) as client:
        assert client.post("/api/v1/demo/sample").status_code == 404


def test_device_auth_rejection_before_data_write():
    import asyncio
    from fastapi import HTTPException

    class FakeDB:
        writes = 0

        async def request(self, method, path, **kwargs):
            if method == "GET":
                return []
            self.writes += 1
            return []

    payload = DeviceIngest(device_token="x" * 40, session_id="session", readings=[Reading(measured_at=datetime.now(timezone.utc), accel_x=0, accel_y=0, accel_z=0, gyro_x=0, gyro_y=0, gyro_z=0)])
    db = FakeDB()
    with pytest.raises(HTTPException) as error:
        asyncio.run(_ingest(payload, None, cast(Any, db), Settings(supabase_service_role_key="test")))
    assert error.value.status_code == 401
    assert db.writes == 0


def test_authenticated_device_ingest_matches_hash_and_marks_seen_only_after_reading_write():
    import asyncio

    token = "physical-device-token-with-strong-entropy"
    secret = "server-only-device-hmac-secret-123456"
    digest = device_token_digest(token, secret)
    order = []

    class FakeDB:
        async def request(self, method, path, **kwargs):
            if method == "GET" and path.startswith("/rest/v1/sensor_devices?"):
                assert f"access_token_hash=eq.{digest}" in path
                assert kwargs["service"] is True
                assert digest not in " ".join(str(v) for v in kwargs.get("json", {}).values())
                order.append("device-token-verified")
                return [{"id": "device-uuid-1", "patient_id": "patient-uuid-1", "device_identifier": "ESP32_001", "is_active": True, "status": "active", "access_token_hash": digest}]
            if method == "GET" and path.startswith("/rest/v1/monitoring_sessions?"):
                assert "id=eq.session-uuid-1" in path
                assert "device_id=eq.device-uuid-1" in path
                assert "patient_id=eq.patient-uuid-1" in path
                order.append("active-session-verified")
                return [{"id": "session-uuid-1", "status": "active", "mode": "real"}]
            if method == "POST" and path == "/rest/v1/sensor_readings":
                assert kwargs["json"][0]["device_id"] == "device-uuid-1"
                assert kwargs["json"][0]["patient_id"] == "patient-uuid-1"
                assert kwargs["json"][0]["source"] == "device"
                order.append("readings-written")
                return None
            if method == "PATCH" and path == "/rest/v1/sensor_devices?id=eq.device-uuid-1":
                assert set(kwargs["json"]) == {"last_seen_at"}
                order.append("device-marked-seen")
                return None
            raise AssertionError(f"Unexpected request: {method} {path}")

    payload = DeviceIngest(
        device_token=token,
        device_identifier="ESP32_001",
        session_id="session-uuid-1",
        readings=[Reading(measured_at=datetime.now(timezone.utc), accel_x=0, accel_y=0, accel_z=9.8, gyro_x=0, gyro_y=0, gyro_z=0, relative_angle_degrees=0)],
    )
    result = asyncio.run(_ingest(payload, None, cast(Any, FakeDB()), Settings(supabase_service_role_key="server-only-service-role", device_auth_secret=secret)))

    assert result == {"accepted": 1, "session_id": "session-uuid-1"}
    assert order == ["device-token-verified", "active-session-verified", "readings-written", "device-marked-seen"]


def test_oversized_body_rejected_before_auth():
    app = create_app(Settings())
    with TestClient(app) as client:
        response = client.post("/api/v1/sensor/readings", content="{}", headers={"content-length": "300000"})
        assert response.status_code == 413


def test_chunked_oversized_body_without_length_is_rejected():
    import asyncio

    chunks = iter([
        {"type": "http.request", "body": b"x" * 200_000, "more_body": True},
        {"type": "http.request", "body": b"y" * 56_001, "more_body": False},
    ])
    sent = []

    async def receive():
        return next(chunks)

    async def send(message):
        sent.append(message)

    async def must_not_parse(_scope, _receive, _send):
        raise AssertionError("Oversized request reached the inner FastAPI app")

    scope = {"type": "http", "path": "/api/v1/sensor/readings", "method": "POST", "headers": [], "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1", "scheme": "http", "raw_path": b"/api/v1/sensor/readings", "query_string": b"", "root_path": "", "client": ("test", 1), "server": ("test", 80)}
    asyncio.run(jointcare_api.ApiBodyLimitMiddleware(must_not_parse)(scope, receive, send))
    start = next(message for message in sent if message["type"] == "http.response.start")
    assert start["status"] == 413


def test_browser_runtime_config_exposes_only_supabase_public_values():
    app = create_app(Settings(supabase_url="https://example.supabase.co", supabase_anon_key="sb_publishable_test", supabase_service_role_key="never-send-service-role", device_auth_secret="never-send-device-secret"))
    with TestClient(app) as client:
        response = client.get("/jointcare-config.js")
        assert response.status_code == 200
        assert "https://example.supabase.co" in response.text
        assert "sb_publishable_test" in response.text
        assert "never-send-service-role" not in response.text
        assert "never-send-device-secret" not in response.text
        assert response.headers["cache-control"] == "no-store"


def test_api_rate_limit_returns_retry_after_but_health_stays_available():
    app = create_app(Settings(demo_mode=True, rate_limit_requests=1))
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.post("/api/v1/demo/sample").status_code == 200
        limited = client.post("/api/v1/demo/sample")
        assert limited.status_code == 429
        assert int(limited.headers["retry-after"]) >= 1


def test_device_digest_is_hmac_and_non_finite_angles_are_omitted():
    token = "device-token-with-enough-entropy"
    digest = device_token_digest(token, "server-only-secret")
    assert len(digest) == 64
    assert digest != token
    result = analyze_trend([{"relative_angle_degrees": float("nan")}, {"relative_angle_degrees": float("inf")}])
    assert result["quality"]["status"] == "missing"


def test_patient_analysis_compares_pain_and_stiffness_only_on_paired_dates():
    readings = [
        {"measured_at": f"2026-10-{day:02d}T10:00:00+00:00", "relative_angle_degrees": angle}
        for day, angle in ((24, 10), (25, 20), (26, 30), (27, 40))
    ]
    symptoms = [
        {"recorded_at": f"2026-10-{day:02d}T12:00:00+00:00", "pain_score": pain, "stiffness_score": stiffness}
        for day, pain, stiffness in ((24, 2, 8), (25, 4, 6), (26, 8, 4))
    ]
    result = analyze_patient_trends(readings, symptoms)
    assert result["metrics"]["pain_angle_pair_days"] == 3
    assert result["metrics"]["stiffness_angle_pair_days"] == 3
    assert result["metrics"]["later_minus_earlier_mean_degrees"] == 20.0
    assert result["metrics"]["pain_angle_association_r"] > 0.98
    assert result["metrics"]["stiffness_angle_association_r"] == -1.0
    assert "does not establish cause" in result["summary"]
    assert "stationary reference calibration limit comparisons" in result["summary"]


def test_analysis_endpoint_reads_as_user_and_persists_only_after_auth(monkeypatch):
    created = []
    readings = [
        {"measured_at": f"2026-10-{day:02d}T10:00:00+00:00", "relative_angle_degrees": angle}
        for day, angle in ((24, 10), (25, 20), (26, 30), (27, 40))
    ]
    symptoms = [
        {"recorded_at": f"2026-10-{day:02d}T12:00:00+00:00", "pain_score": pain, "stiffness_score": stiffness}
        for day, pain, stiffness in ((24, 2, 8), (25, 4, 6), (26, 8, 4))
    ]

    class FakeSupabase:
        def __init__(self, _settings):
            self.calls = []
            created.append(self)

        async def request(self, method, path, *, token, service=False, **kwargs):
            self.calls.append({"method": method, "path": path, "token": token, "service": service, **kwargs})
            if path == "/auth/v1/user":
                return {"id": "patient-1"}
            if path.startswith("/rest/v1/sensor_readings?"):
                return readings
            if path.startswith("/rest/v1/symptom_records?"):
                return symptoms
            if path == "/rest/v1/analysis_results":
                return [kwargs["json"] | {"id": "analysis-1", "generated_at": "2026-10-27T10:00:00+00:00"}]
            raise AssertionError(f"Unexpected request: {method} {path}")

        async def close(self):
            return None

    monkeypatch.setattr(jointcare_api, "Supabase", FakeSupabase)
    settings = Settings(supabase_url="https://example.supabase.co", supabase_anon_key="publishable-test", supabase_service_role_key="service-role-test", device_auth_secret="device-secret-test-1234567890123456")
    with TestClient(create_app(settings)) as client:
        unauthenticated = client.post("/api/v1/analytics/generate?days=30", json={})
        assert unauthenticated.status_code == 401
        response = client.post("/api/v1/analytics/generate?days=30", json={}, headers={"Authorization": "Bearer patient-access-token"})
    assert response.status_code == 201
    record = response.json()
    assert record["patient_id"] == "patient-1"
    assert record["source"] == "rule_based"
    assert "pain_angle_association_r" in record["metrics"]
    assert record["metrics"]["later_minus_earlier_mean_degrees"] == 20.0
    assert created
    auth_reads = [call for call in created[0].calls if call["path"].startswith("/rest/v1/") and call["method"] == "GET"]
    assert auth_reads and all(call["token"] == "patient-access-token" and not call["service"] for call in auth_reads)
    saved = next(call for call in created[0].calls if call["path"] == "/rest/v1/analysis_results")
    assert saved["token"] == "service-role-test" and saved["service"] is True


def test_symptom_endpoint_validates_auth_and_uses_patient_token_for_insert(monkeypatch):
    created = []

    class FakeSupabase:
        def __init__(self, _settings):
            self.insert = None
            created.append(self)

        async def request(self, method, path, *, token, service=False, **kwargs):
            if path == "/auth/v1/user":
                return {"id": "patient-1"}
            if path == "/rest/v1/symptom_records" and method == "POST":
                self.insert = {"token": token, "service": service, **kwargs["json"]}
                return [{"id": "symptom-1", **kwargs["json"]}]
            raise AssertionError(f"Unexpected request: {method} {path}")

        async def close(self):
            return None

    monkeypatch.setattr(jointcare_api, "Supabase", FakeSupabase)
    settings = Settings(supabase_url="https://example.supabase.co", supabase_anon_key="publishable-test", supabase_service_role_key="service-role-test", device_auth_secret="device-secret-test-1234567890123456")
    symptom = {"recorded_at": "2026-10-27T12:00:00+00:00", "joint": "Knee", "pain_score": 4, "stiffness_score": 3, "swelling": False, "activity": "Walk", "notes": ""}
    with TestClient(create_app(settings)) as client:
        forged = client.post("/api/v1/symptoms", json=symptom | {"source": "simulated_demo_only"}, headers={"Authorization": "Bearer patient-access-token"})
        response = client.post("/api/v1/symptoms", json=symptom, headers={"Authorization": "Bearer patient-access-token"})
    assert forged.status_code == 422
    assert response.status_code == 201
    assert response.json()["patient_id"] == "patient-1"
    assert created[0].insert["token"] == "patient-access-token"
    assert created[0].insert["service"] is False
    assert created[0].insert["source"] == "patient"


def test_real_session_requires_hardware_and_never_persists_demo_mode(monkeypatch):
    created = []

    class FakeSupabase:
        def __init__(self, _settings):
            self.calls = []
            created.append(self)

        async def request(self, method, path, *, token, service=False, **_kwargs):
            self.calls.append((method, path, token, service))
            if path == "/auth/v1/user":
                return {"id": "patient-1"}
            raise AssertionError(f"No session write should occur: {method} {path}")

        async def close(self):
            return None

    monkeypatch.setattr(jointcare_api, "Supabase", FakeSupabase)
    settings = Settings(supabase_url="https://example.supabase.co", supabase_anon_key="publishable-test", supabase_service_role_key="service-role-test", device_auth_secret="device-secret-test-1234567890123456")
    with TestClient(create_app(settings)) as client:
        simulated = client.post("/api/v1/sensor/sessions/start", json={"mode": "demo"}, headers={"Authorization": "Bearer patient-access-token"})
        unattached = client.post("/api/v1/sensor/sessions/start", json={"mode": "real"}, headers={"Authorization": "Bearer patient-access-token"})
    assert simulated.status_code == 400 and "local-only" in simulated.json()["detail"]
    assert unattached.status_code == 400 and "device" in unattached.json()["detail"]
    assert created and all(call[1] == "/auth/v1/user" for call in created[0].calls)


def test_device_listing_and_session_start_use_auth_patient_uuid_and_active_schema_flags(monkeypatch):
    created = []

    class FakeSupabase:
        def __init__(self, _settings):
            self.calls = []
            created.append(self)

        async def request(self, method, path, *, token, service=False, **kwargs):
            self.calls.append({"method": method, "path": path, "token": token, "service": service, **kwargs})
            if path == "/auth/v1/user":
                return {"id": "patient-auth-1"}
            if path.startswith("/rest/v1/sensor_devices?") and method == "GET":
                assert "patient_id=eq.patient-auth-1" in path
                assert "is_active=eq.true" in path and "status=eq.active" in path
                if "id=eq." in path and "another-patient-device" in path:
                    return []
                if "id=eq." in path:
                    assert "select=id" in path
                    return [{"id": "device-uuid-1"}]
                assert "device_identifier" in path and "select=id," in path
                return [{"id": "device-uuid-1", "device_identifier": "ESP32_001", "patient_id": "patient-auth-1", "is_active": True, "status": "active", "last_seen_at": None}]
            if path == "/rest/v1/monitoring_sessions" and method == "POST":
                assert kwargs["json"]["patient_id"] == "patient-auth-1"
                assert kwargs["json"]["device_id"] == "device-uuid-1"
                return [{"id": "session-1", **kwargs["json"]}]
            raise AssertionError(f"Unexpected request: {method} {path}")

        async def close(self):
            return None

    monkeypatch.setattr(jointcare_api, "Supabase", FakeSupabase)
    service_key = "server-only-service-role-test-01234567890123456789"
    settings = Settings(supabase_url="https://example.supabase.co", supabase_anon_key="publishable-test", supabase_service_role_key=service_key, device_auth_secret="device-secret-test-1234567890123456")
    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": "Bearer patient-access-token"}
        listed = client.get("/api/v1/sensor/devices/status", headers=headers)
        started = client.post("/api/v1/sensor/sessions/start", json={"mode": "real", "device_id": "device-uuid-1"}, headers=headers)
        wrong_owner = client.post("/api/v1/sensor/sessions/start", json={"mode": "real", "device_id": "another-patient-device"}, headers=headers)

    assert listed.status_code == 200
    assert [device["id"] for device in listed.json()] == ["device-uuid-1"]
    assert started.status_code == 201 and started.json()["device_id"] == "device-uuid-1"
    assert wrong_owner.status_code == 403
    calls = created[0].calls
    device_reads = [call for call in calls if call["path"].startswith("/rest/v1/sensor_devices?")]
    assert device_reads and all(call["token"] == service_key and call["service"] is True for call in device_reads)
    session_insert = next(call for call in calls if call["path"] == "/rest/v1/monitoring_sessions")
    assert session_insert["token"] == "patient-access-token" and session_insert["service"] is False


def test_supabase_migration_declares_rls_and_no_direct_sensor_write_policies():
    migration_path = Path(__file__).resolve().parents[1] / "supabase" / "migrations" / "20261027000000_jointcare_initial_schema.sql"
    migration = migration_path.read_text()
    for table in ("profiles", "patient_settings", "trusted_emergency_contacts", "sensor_devices", "monitoring_sessions", "sensor_readings", "symptom_records", "analysis_results", "clinician_patient_access"):
        assert f"alter table public.{table} enable row level security" in migration
    assert "create policy readings_read_own_or_assigned" in migration
    assert "create policy profiles_update_self_patient_only" in migration
    assert "create policy access_read_participants" in migration
    for policy in ("sessions_insert_own", "sessions_update_own", "sessions_delete_own"):
        line = next(line for line in migration.splitlines() if line.startswith(f"create policy {policy} "))
        assert "public.jointcare_is_patient()" in line
    assert "new.source := 'patient'" in migration
    assert "before insert or update on public.symptom_records" in migration
    contact_policies = [line for line in migration.splitlines() if line.lstrip().startswith("create policy trusted_contacts_")]
    assert len(contact_policies) == 4
    assert all("public.trusted_emergency_contacts" in line and "jointcare_is_assigned" not in line and "jointcare_is_patient()" in line for line in contact_policies)
    assert "revoke all on table public.trusted_emergency_contacts from anon, public" in migration
    assert "phone_e164 ~ '^[+][1-9][0-9]{7,14}$'" in migration
    assert "create or replace function public.jointcare_is_patient()" in migration
    assert "create policy readings_insert" not in migration
    assert "create policy device_insert" not in migration


# ---- ESP32 ingest hardening -------------------------------------------------
_TOKEN = "physical-device-token-with-strong-entropy"
_SECRET = "server-only-device-hmac-secret-123456"
_SESSION = "11111111-1111-4111-8111-111111111111"
_READING = {"measured_at": "2026-10-27T01:28:00Z", "accel_x": 0.1, "accel_y": 0.0, "accel_z": 9.8, "gyro_x": 0, "gyro_y": 0, "gyro_z": 0, "relative_angle_degrees": 1.5}


def _ingest_client(monkeypatch, device=None, session=None):
    state = {"writes": [], "patches": []}
    digest = device_token_digest(_TOKEN, _SECRET)
    base = {"id": "dev-1", "patient_id": "pat-1", "device_identifier": "ESP32_001", "is_active": True, "status": "active", "access_token_hash": digest}

    class FakeSupabase:
        def __init__(self, _s):
            pass

        async def request(self, method, path, *, token, service=False, **kw):
            if path.startswith("/rest/v1/sensor_devices?access_token_hash="):
                return [base | (device or {})] if path.split("=")[1].split("&")[0] == "eq." + digest else []
            if path.startswith("/rest/v1/monitoring_sessions?"):
                assert "patient_id=eq.pat-1" in path and "device_id=eq.dev-1" in path
                return [{"id": _SESSION, "status": "active", "mode": "real"} | (session or {})] if session != "none" else []
            if method == "POST" and path == "/rest/v1/sensor_readings":
                state["writes"].append(kw["json"])
                return None
            if method == "PATCH":
                state["patches"].append(kw["json"])
                return None
            raise AssertionError(path)

        async def close(self):
            return None

    monkeypatch.setattr(jointcare_api, "Supabase", FakeSupabase)
    cfg = Settings(supabase_url="https://x.supabase.co", supabase_anon_key="anon-public", supabase_service_role_key="service-role-key-0123456789012345678901", device_auth_secret=_SECRET)
    return TestClient(create_app(cfg)), state


def _post(client, token_header=True, body_token=False, **over):
    body = {"session_id": _SESSION, "readings": [_READING]} | over
    if body_token:
        body["device_token"] = _TOKEN
    headers = {"Authorization": f"Bearer {_TOKEN}"} if token_header else {}
    return client.post("/api/v1/sensor/devices/ingest", json=body, headers=headers)


def test_ingest_accepts_bearer_only_token_and_stores_with_server_ids(monkeypatch):
    client, state = _ingest_client(monkeypatch)
    with client:
        r = _post(client, device_identifier="ESP32_001")
    assert r.status_code == 201 and r.json()["accepted"] == 1
    row = state["writes"][0][0]
    assert row["device_id"] == "dev-1" and row["patient_id"] == "pat-1" and row["session_id"] == _SESSION and row["source"] == "device"
    assert state["patches"] == [{"last_seen_at": state["patches"][0]["last_seen_at"]}]


def test_ingest_missing_or_mismatched_token_is_401_and_writes_nothing(monkeypatch):
    client, state = _ingest_client(monkeypatch)
    with client:
        none = _post(client, token_header=False)
        bad = client.post("/api/v1/sensor/devices/ingest", json={"session_id": _SESSION, "readings": [_READING]}, headers={"Authorization": "Bearer " + "z" * 40})
        both = client.post("/api/v1/sensor/devices/ingest", json={"session_id": _SESSION, "readings": [_READING], "device_token": "y" * 40}, headers={"Authorization": f"Bearer {_TOKEN}"})
    assert none.status_code == 401 and bad.status_code == 401 and both.status_code == 401
    assert "rotate-token" in bad.json()["detail"]
    assert not state["writes"] and not state["patches"]


@pytest.mark.parametrize("device", [{"is_active": False}, {"status": "inactive"}, {"status": "revoked"}])
def test_ingest_rejects_inactive_device_with_403(monkeypatch, device):
    client, state = _ingest_client(monkeypatch, device=device)
    with client:
        r = _post(client)
    assert r.status_code == 403 and "not active" in r.json()["detail"] and not state["writes"]


def test_ingest_rejects_identifier_mismatch(monkeypatch):
    client, state = _ingest_client(monkeypatch)
    with client:
        r = _post(client, device_identifier="esp32-motion-01")
    assert r.status_code == 403 and "device_identifier" in r.json()["detail"] and not state["writes"]


def test_ingest_session_errors_are_distinct(monkeypatch):
    for session, code in (("none", 404), ({"status": "completed"}, 409), ({"status": "paused"}, 409), ({"mode": "demo"}, 403)):
        client, state = _ingest_client(monkeypatch, session=session)
        with client:
            r = _post(client)
        assert r.status_code == code and not state["writes"], (session, r.text)


def test_ingest_validation_errors_never_echo_the_token_and_session_must_be_uuid(monkeypatch):
    client, _ = _ingest_client(monkeypatch)
    with client:
        short = client.post("/api/v1/sensor/devices/ingest", json={"device_token": "tooshort-secret", "session_id": _SESSION, "readings": [_READING]})
        bad_session = _post(client, session_id="not-a-uuid")
    assert short.status_code == 422 and "tooshort-secret" not in short.text
    assert bad_session.status_code == 422 and "UUID" in bad_session.json()["detail"]


def test_ingest_logs_ids_but_never_token_or_digest(monkeypatch, caplog):
    import logging
    client, _ = _ingest_client(monkeypatch, device={"status": "revoked"})
    with caplog.at_level(logging.INFO, logger="jointcare.ingest"), client:
        _post(client)
    text = caplog.text
    assert "device_inactive" in text and "dev-1" in text
    assert _TOKEN not in text and device_token_digest(_TOKEN, _SECRET) not in text
