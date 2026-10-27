# JointCare AI API

FastAPI OpenAPI is served at `/openapi.json` by the application. Production uses same-origin relative paths over HTTPS. Local web development proxies `/api/v1` from Astro port 3000 to FastAPI port 8000.

## Health and runtime configuration

| Method/path | Purpose |
| --- | --- |
| `GET /health` | Liveness response for local checks. |
| `GET /healthz` | Unauthenticated 200 response used by the hosted container health probe. It does not test Supabase connectivity. |
| `GET /ready` | Returns 200 if required configuration is present; otherwise 503 with missing variable names. It does not make a live database transaction. |
| `GET /jointcare-config.js` | No-store browser-safe configuration script containing only Supabase URL and publishable key. It never returns the service-role key or device-auth secret. |

## Authentication and device provisioning

Patient-facing user routes require `Authorization: Bearer <Supabase access token>`. The backend validates it with Supabase Auth; database ownership is additionally constrained by RLS.

### `POST /api/v1/sensor/devices/register`

Authenticated patient request, JSON body:

```json
{"device_identifier":"esp32-knee-left-01"}
```

Returns the authorized device row and one random device token exactly once. The client should copy it into an untracked local `secrets.h`. The backend stores only an HMAC-SHA256 digest keyed by the effective server-only device key: a distinct `DEVICE_AUTH_SECRET` override or a domain-separated derivation from the protected service-role key; the raw token is not recoverable from the database. Changing the effective key invalidates existing tokens, which must be re-enrolled.

### `POST /api/v1/sensor/devices/rotate-token`

Authenticated patient request, body `{"device_identifier":"ESP32_001"}`. For a device row you already own (for example one created directly in Supabase, whose stored hash does not match any token), issues a new one-time token, re-activates the row and keeps its UUID/identifier. The old token stops working.

### `POST /api/v1/sensor/sessions/start`

Authenticated patient request. For real hardware, choose one of the patient's active enrolled device IDs:

```json
{"mode":"real","device_id":"<sensor_devices UUID>"}
```

For browser-only simulation, the UI never calls this route; demo sessions stay in browser state. Returns the Supabase monitoring-session row, including the `id` needed by the firmware. Start the session in the dashboard, then copy the displayed ID into the local firmware settings before powering the device.

### `POST /api/v1/sensor/sessions/pause?session_id=<id>`
### `POST /api/v1/sensor/sessions/resume?session_id=<id>`
### `POST /api/v1/sensor/sessions/stop?session_id=<id>`

Authenticated patient transitions on that patient's session only. The database statuses are `active`, `paused`, `completed` and `cancelled`; completed sessions get `ended_at`.

### `GET /api/v1/sensor/sessions/{session_id}`

Returns the authenticated patient's requested session only.

### `GET /api/v1/sensor/devices/status`

Returns that authenticated patient's device identifiers and active/last-seen status only. The UI uses saved timestamps rather than claiming a socket-level connection.

## Sensor batches

### `POST /api/v1/sensor/readings`

Authenticated patient route for an authorized device token. The client must supply `device_token`, an active owned `session_id`, and 1–250 timestamped readings. The backend verifies the device token, patient ownership, device/session association and active session before writing. The sensor table receives server-assigned patient/device IDs and `source=device`.

### `POST /api/v1/sensor/devices/ingest`

Device route used by the firmware (HTTPS only). The device token may be sent as `Authorization: Bearer …`, as body `device_token`, or both (they must match). Optional `device_identifier` is verified against the token's enrolled device:

```json
{
  "device_token":"<one-time-provisioned-token>",
  "device_identifier":"ESP32_001",
  "session_id":"<active-monitoring-session-uuid>",
  "readings":[
    {
      "measured_at":"2026-10-27T01:28:00Z",
      "accel_x":0.12,
      "accel_y":0.04,
      "accel_z":9.79,
      "gyro_x":0.01,
      "gyro_y":0.02,
      "gyro_z":0.00,
      "relative_angle_degrees":2.3
    }
  ]
}
```

Timestamps require an explicit timezone. Axis limits are enforced by both Pydantic and SQL. Empty/oversized batches are rejected. Device ingestion is only allowed for an active session belonging to that enrolled device. Hardware enrollment and account/session creation are user-authenticated; firmware cannot create arbitrary patient/session links.

## Symptoms and summaries

### `POST /api/v1/symptoms`

Authenticated patient JSON requires `recorded_at` with timezone, `joint`, integer `pain_score` and `stiffness_score` from 0 through 10, and boolean `swelling`; `discomfort`, `activity`, and `notes` are optional and length limited. The backend assigns `patient_id` from the validated Supabase token and fixes `source` to `patient`; client-supplied provenance is rejected. The SQL migration also uses a trigger to enforce `patient` on non-service-role direct Supabase inserts and updates.

### `GET /api/v1/analytics/trends?days=30`

Authenticated patient route. `days` is an integer 1–365 (default 30). Returns sample counts, observed average/span where possible, missing-angle quality status, and a plain-language non-diagnostic disclaimer. It does not persist fabricated or clinical analysis. Relative angles are not a clinically calibrated range.

### `POST /api/v1/analytics/generate?days=30`

Authenticated user action (the dashboard's **Refresh summary** button). Reads only that user's sensor and symptom records with the user's validated Supabase token, computes transparent rule-based earlier/later comparisons and daily pain/stiffness associations when enough paired dates exist, then stores the result in `analysis_results` with `source=rule_based` through the server-only service role. `days` is 1–365 (default 30). The result carries sample/missingness coverage and the stationary calibration/mounting limitation. No external AI service is called and demo records are not included. This endpoint is not a diagnosis, clinical range calculation or treatment recommendation.

### `POST /api/v1/demo/sample`

Synthetic sample endpoint is disabled by default (404). It only runs with `DEMO_MODE=true` and returns `simulated_demo_only` data with `persisted:false`; it does not write to Supabase.

### `DELETE /api/v1/account`

Authenticated and destructive. Removes the current Supabase Auth user with the server-only service-role key; the migration's `ON DELETE CASCADE` foreign keys remove linked application data. The UI asks for confirmation before sending it. Export records first if needed.

## Limits and errors

- Sensor request bodies are guarded at 256 KiB when `Content-Length` is supplied; sensor batches are capped at 250 rows. Configure the hosting gateway to apply an equivalent body-size ceiling to streamed/chunked requests.
- In-process sliding windows default to 300 API requests per authenticated token/client per minute and 60 device-ingest requests per device/client per minute. This limiter is memory-local to one process and is not a distributed quota; use a gateway/shared limiter if scaling to multiple instances.
- Ingest errors: 401 unknown/missing/mismatched token; 403 device inactive/revoked, identifier mismatch, or non-real session; 404 session not found for this device; 409 session paused/completed; 422 schema (session_id must be a UUID; error bodies never echo submitted values). Server logs (`jointcare.ingest`) record reason codes and IDs only, never tokens or digests.
- Typical responses use 401 (missing/invalid user/device auth), 403 (wrong owner/device/session), 404 (missing/disabled route), 413 (declared body too large), 422 (invalid schema/field), 429 (rate limit; `Retry-After` set), 502 (upstream Supabase failure), and 503 (backend configuration unavailable). Unexpected errors use a generic 500 message without echoing private upstream details.

Use synthetic accounts for API integration. Never put a service-role key in a client request, firmware, published file or log.
