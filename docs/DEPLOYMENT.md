# JointCare AI deployment

## Manus-hosted application

The application uses one server-enabled Manus container, not a separate static build plus Python service. Root `Dockerfile` installs the pinned Node toolchain, builds Astro into `frontend/dist`, installs Python runtime dependencies, copies the frontend into the image, and starts FastAPI on the `PORT` supplied by the platform (falling back to 3000). FastAPI mounts its authenticated `/api/v1` routes before serving compiled files/SPA paths. The required container health route is `GET /healthz`, which returns an unauthenticated 200 without credentials.

Preview development uses Astro on port 3000 and FastAPI on port 8000. The Vite proxy keeps browser API requests relative; hardware must use the public deployed HTTPS origin, not the in-sandbox Preview port.

## Environment variables

Supply configuration through protected project environment settings or a local, ignored `.env`. `.env.example` contains only names and blank/example values.

| Variable | Exposure | Purpose |
| --- | --- | --- |
| `PUBLIC_SUPABASE_URL` | Browser-safe | Supabase project URL for the client SDK. `SUPABASE_URL` is also accepted server-side. |
| `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Browser-safe | Supabase publishable key; `PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_ANON_KEY` remain accepted aliases. RLS—not secrecy of this key—is the data security boundary. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Privileged hardware enrollment/ingestion and authenticated account deletion. Never return it to a browser. |
| `DEVICE_AUTH_SECRET` | Server only, optional | Unique high-entropy HMAC key of at least 32 characters, distinct from every public Supabase key. If missing, weak, or overlapping a public key, the backend derives a domain-separated key from the server-only service-role credential. |
| `DEMO_MODE` | Server only, optional | Enables the isolated sample API endpoint only when explicitly `true`; normal UI demo data is browser-local. Default false. |
| `RATE_LIMIT_REQUESTS` | Server only, optional | Per-token/client API request ceiling per window; default 300. |
| `DEVICE_RATE_LIMIT_REQUESTS` | Server only, optional | Device-ingest request ceiling per window; default 60. |
| `RATE_LIMIT_WINDOW_SECONDS` | Server only, optional | In-process limit window, default 60 seconds. |
| `PORT` | Runtime | Container listener port supplied by Manus; defaults to 3000. |
| `DATABASE_URL` | Server only, optional | Reserved/documentary direct PostgreSQL connection value; current code uses Supabase REST, not direct SQL. |
| `API_BASE_URL` | Public/example | Browser uses relative paths; the firmware uses the deployed origin and appends route paths. |

The browser loads `/jointcare-config.js`. In production the FastAPI handler emits only `supabaseUrl` and `publishableKey` with `Cache-Control: no-store`, allowing credentials to be supplied at runtime rather than compiled into an image. The committed public file used by local development is an empty object. The public publishable key is intentionally visible; the service-role credential and effective (distinct) device HMAC key must not appear in frontend assets. If a configured `DEVICE_AUTH_SECRET` overlaps the public key, the backend ignores that candidate and derives a separate key at runtime.

## Supabase setup before real accounts

1. In Supabase, review and manually apply `supabase/migrations/20261027000000_jointcare_initial_schema.sql` to the intended project. The task did not automatically execute SQL in the remote project. Back up/review same-named tables before applying.
2. Check Authentication email confirmation policy and set the correct Site URL/Redirect URLs for the deployed origin and any origins used for Preview/local development. Password recovery returns to `/?auth=recovery`; the callback opens a new-password form after Supabase validates the recovery session.
3. Supply the URL and publishable key in the browser-safe project variables and server aliases; supply the service-role key only to backend runtime. `DEVICE_AUTH_SECRET` is optional; if configured, it must be a unique 32+ character server-only value distinct from public keys. If it is missing, weak, or overlaps a browser-visible key, the backend derives a domain-separated device HMAC key from the private service-role key.
4. Confirm sign-up creates a `profiles` row with role `patient`, and test the policies with separate synthetic patients/clinician accounts in a non-production project before onboarding real users. Verify patients cannot read another patient's trusted contact and assigned clinicians cannot read `trusted_emergency_contacts`.
5. Clinicians are provisioned through a trusted administrator/operator path: verify the account ID, assign a `clinician` role, then create an explicit row in `clinician_patient_access`. Never enable client-side self-promotion.

The application reports backend configuration readiness at `/ready`; that endpoint checks required configuration presence, not whether your Supabase URL, key, schema, email settings or RLS are remotely correct. Validate them in a separate test project/account before using real health-related records.

The patient-only SOS feature stores one trusted contact under its own RLS policy. The patient must explicitly choose Call or Text in a confirmation dialog; the web app opens the device dialer or a generic editable SMS draft, but never auto-sends or includes location, sensor, symptom, health/session or account data. Device/browser support varies; SOS does not replace local emergency services.

## Hardware rollout

Publish the container first, identify its public HTTPS origin, validate the TLS chain, and use a non-production Supabase test account. Enroll the ESP32 from the signed-in app, copy the one-time device token and an active session ID, then configure a local ignored `secrets.h`. Follow `docs/esp32_mpu6050.md`. Hardware was not available to this implementation, so physical wiring, TLS, actual records, deployment and sensor readings remain owner-run verification steps.

## Data safety

Container storage is ephemeral. Patient data belongs in Supabase; do not write durable user records to a local file or process memory. The demo workspace uses simulated browser-local records only. Use HTTPS, rotation/revocation procedures, least privilege, data retention and deletion workflows, and an appropriate privacy review before collecting health-related information.
