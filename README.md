# JointCare AI

**Understand Every Movement.** JointCare AI is a movement-and-symptom journal with an explicitly simulated demo workspace, optional Supabase-backed patient accounts, an explainable monitoring summary, history/export, a restricted clinician view, a confirmation-first trusted-contact SOS action, and an ESP32 + MPU6050 integration example.

> JointCare AI is a software logging tool, not a medical device. It does not diagnose a condition, detect inflammation, recommend treatment, or establish clinical range of motion. A relative angle is a sensor orientation estimate, not a clinical measurement.

## What works in this project

- **Demo workspace:** local-only sample profile, clearly labelled simulated movement, sessions and symptoms; users can exercise profile editing, symptom entry, charts, history and reports without a sensor or Supabase account. Demo entries use browser storage and are never submitted to real patient tables.
- **Patient account mode:** Supabase email/password sign-up, sign-in, sign-out and password recovery; profile/joint preference and symptom CRUD; account-scoped trends and history under PostgreSQL RLS.
- **Trusted-contact SOS:** patient accounts may store one private E.164 contact. SOS opens a confirmation dialog with Call and Text actions; Call opens the device dialer and Text opens a generic editable draft. No auto-call/send, location, sensor, or health/session data is shared. SOS is disabled for real contact actions in the demo.
- **Monitoring:** separate demo and real-hardware modes, demo sample chart, authorized device enrollment, start/pause/resume/stop session controls, one-time device token display, active session ID display, batched sensor API and explicit connection/data-quality status.
- **History and clinician view:** date-filtered records, session comparison, CSV export and print styles; assigned-patient dashboard for a clinician role provisioned by a trusted administrator.
- **Explainable summary:** patient users can explicitly refresh a persistent, rule-based summary comparing earlier and later observed groups and paired movement/pain/stiffness dates when enough data exist. No identifiable patient data is sent to an external AI service.
- **Hardware source:** ESP32 + MPU6050 Arduino sketch with conservative sampling, stationary calibration, simple filtering, UTC timestamps, certificate-verified HTTPS, a bounded RAM batch and retry/backoff. The sketch has not been compiled against a physical board or tested with a deployed service.

## Prerequisites

- Node.js 22.x and pnpm 11.25.0 (the package manager version is pinned in `package.json`).
- Python 3.12 (or another compatible Python 3.11+ release), pip and a virtual environment.
- Supabase project for real authentication/data; physical ESP32 and MPU6050 only for the optional hardware path.

## Run locally

From the project root:

```bash
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
python3 -m venv backend/.venv
. backend/.venv/bin/activate
python -m pip install -r backend/requirements.txt
cp .env.example .env
```

Leave credential placeholders blank to run the **simulated demo**. For real Supabase login/data, populate the browser-safe and server-only settings described in `.env.example` and `docs/DEPLOYMENT.md`. `DEVICE_AUTH_SECRET` may be left blank: the backend derives a domain-separated device HMAC key from the server-only service-role credential when the optional override is missing, weak, or overlaps a public Supabase key. Never commit `.env`.

Start the API and web dev server in two terminals (from the repository root):

```bash
. backend/.venv/bin/activate
uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
```

```bash
pnpm dev
```

Astro runs on port 3000 and proxies relative `/api/v1` requests to FastAPI at port 8000. The built-in Manus Preview is configured for port 3000. Open the hosted Preview from the project workspace; this repository does not include a separate Preview URL.

## Supabase setup

The project includes an additive migration at `supabase/migrations/20261027000000_jointcare_initial_schema.sql` for the eight requested application tables plus `trusted_emergency_contacts`. The migration enables RLS, limits authenticated users to their own permitted records, exposes clinician records only through active explicit assignments, and makes trusted-contact rows patient-only (no clinician policy). `supabase/seed.sql` is intentionally a no-op so synthetic records cannot be inserted into real accounts.

**The migration has not been run against the remote Supabase project.** Review it, back up/inspect any same-named tables, then apply it yourself through the Supabase SQL Editor or your migration workflow. See `supabase/SETUP.md`. Auth signup creates a patient profile by default; user metadata cannot assign clinician privileges. A trusted administrator must provision clinician roles and assignments.

Add the public project URL/publishable key and server-only service-role/device-auth values to the appropriate hosted/local environment. Supabase Auth's allowed Site URL and redirect URLs must include the deployed application origin and any Preview/local origin you will use. Do not place the service-role key in a browser bundle, firmware or the public repository.

## Checks

```bash
pnpm check
pnpm build
. backend/.venv/bin/activate
python -m pytest -q backend/test_app.py
```

`pnpm check` runs Astro and TypeScript checks plus Python Pyright. Automated backend tests cover model bounds/timestamps and batching; missingness, earlier/later comparison and paired pain/stiffness rules; simulated-demo non-persistence; startup readiness; token digests; authenticated symptom writes; analysis authorization/persistence boundaries; account-session separation; rate limiting; public-config leakage; chunked and declared body-size limits; and static checks for RLS, trusted-contact patient-only policies, symptom provenance and no direct device/readings write policies. They do not execute RLS against Supabase, perform a browser-based authenticated/responsive flow, compile ESP32 firmware, or validate physical wiring. The manual hardware checklist is in `docs/esp32_mpu6050.md`.

## Hosted deployment

Manus server publication uses the root `Dockerfile`: it builds the Astro site, then serves the frontend and FastAPI from one container on the platform's `PORT` (default 3000). `/healthz` is the unauthenticated container health path. See `docs/DEPLOYMENT.md` for the project's required configuration and deployment steps.

## Project map

- `frontend/` — Astro page, React application, Supabase data client, types, charts and responsive styles.
- `backend/app.py` — FastAPI ASGI app, validation/auth/device workflows, REST persistence and rule-based summaries.
- `backend/test_app.py` — deterministic API and analysis tests.
- `supabase/` — database migration, no-op seed and manual setup notes.
- `firmware/esp32_mpu6050/` — board sketch and a credential-free local settings template.
- `docs/` — API, deployment, security and hardware instructions.
- `plan.md` / `TODO.md` — approved architecture and outcome status.

## Privacy and support

Use test accounts and synthetic data during integration. Follow `docs/SECURITY_PRIVACY.md` before handling health-related records. This code does not make legal, clinical, regulatory or security certification claims. Remove records by using the in-app account deletion action (which requires the server-only service role) or by following your Supabase data-retention procedure.
