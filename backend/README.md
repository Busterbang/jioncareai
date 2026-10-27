# JointCare API backend

FastAPI service for patient-owned motion and symptom records. Analytics are descriptive only; relative angles are not clinical ranges. No diagnostic model or external AI is used.

## Run locally

Use Python 3.12. From this directory:

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # replace placeholders with your project values
uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

`GET /health` is liveness. `GET /ready` indicates whether backend configuration is usable. With valid Supabase settings, the API uses the anon key plus the signed-in user's bearer token for user operations; Supabase Auth verifies that token. Service-role access is restricted to device enrollment/credential checks and device ingestion after authentication. RLS and SQL policies must still be configured in Supabase according to the project schema. No credentials are bundled here.

For an isolated simulated sample, set `DEMO_MODE=true`; then `/api/v1/demo/sample` returns clearly simulated data and `persisted: false`. Demo mode does not create sensor rows or make patient operations available without Supabase.

## API routes

- `GET /health`, `GET /ready`
- `POST /api/v1/sensor/devices/register` (signed-in patient; token returned once)
- `GET /api/v1/sensor/devices/status`
- `POST /api/v1/sensor/sessions/start`, `POST /api/v1/sensor/sessions/stop?session_id=…`, `GET /api/v1/sensor/sessions/{session_id}`
- `POST /api/v1/sensor/readings` (signed-in user plus enrolled device token)
- `POST /api/v1/sensor/devices/ingest` (device token only)
- `POST /api/v1/symptoms`
- `GET /api/v1/analytics/trends?days=30`
- `POST /api/v1/demo/sample` (only in demo mode)

FastAPI OpenAPI is available at `/docs` and `/openapi.json`. Sensor batches are limited to 250 readings and 256 KB; schema validates units' numeric bounds, timestamps, and score ranges. Device tokens are generated with the operating system CSPRNG; only SHA-256 digests are stored.

## Test

```sh
pytest -q
```

Tests use no real credentials and do not exercise actual Supabase, hardware, or network integration. Clinician visibility depends on Supabase RLS policies granting only rows connected through `clinician_patient_access`; this API does not expose a clinician-wide/service-role read endpoint.
