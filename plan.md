# JointCare AI — Implementation Plan

## Product and technical approach

Deliver a responsive, demo-ready joint mobility and symptom correlation application. The browser UI is Astro-rendered with a React island for interactive charts, forms and live-monitoring controls; TypeScript, Tailwind CSS, Recharts and Lucide provide typed interactions, styling and data visualization. Supabase Auth and the browser-safe Supabase publishable key authenticate users and support direct patient-scoped reads/writes under PostgreSQL RLS. SQL migrations define the eight requested tables plus patient-only `trusted_emergency_contacts`, with checks, indexes, triggers and role/assignment policies. Privileged device ingestion lives behind FastAPI and uses a server-only Supabase service-role key plus a distinct HMAC device-authentication key; use a unique private `DEVICE_AUTH_SECRET` when available, otherwise derive a domain-separated key from the service-role credential. The effective signing key and service-role key never enter frontend output. The application remains runnable in explicitly simulated demo mode when live configuration is incomplete and must never imply that untested hardware/service integrations are operational.

FastAPI will expose versioned sensor, symptom and trend routes with Pydantic validation, Supabase user-token verification, HMAC-authorized devices, body limits, bounded process-local rate limiting and explainable rule-based analysis. Sensor samples are batched; records retain source/mode separation, UTC timestamps, session and device identity, plus data-quality indicators. Dashboard charts expose 7- and 30-day windows, and the plain-language summary compares available sample groups and paired symptom/movement dates when the data support it. Demo history remains local, simulated and visibly labeled. No external AI service receives identifiable health data, no fabricated data is treated as real or clinical evidence, and summaries never diagnose or recommend medication.

For development, run FastAPI on port 8000 and Astro on the configured Preview port 3000; Astro proxies `/api/v1` to FastAPI so the browser uses relative URLs. The public `jointcare-config.js` fallback is empty in local static assets; in the hosted container FastAPI serves a no-store JavaScript response with only the Supabase project URL and publishable key, keeping runtime values out of the browser build while never exposing service-role/device secrets. For hosted deployment, use one Manus server container: build Astro assets, serve those static assets and SPA entry from FastAPI, mount APIs before the static fallback, honor the platform `PORT`, and provide an unauthenticated `/healthz`. The root `.env.example` contains placeholders only. Supabase migrations remain the authoritative setup script and are not silently executed against the user's remote project.

## Scope boundaries and security

- Supabase project selected by the user: `https://zoxwshgihowtxnbakuva.supabase.co`; only its publishable key may be browser-visible. `SUPABASE_SERVICE_ROLE_KEY` remains server-only; `DEVICE_AUTH_SECRET` is an optional distinct private override, with a server-derived HMAC fallback when missing, weak, or overlapping the public key. The effective HMAC key never reaches frontend assets.
- RLS is the data authorization boundary: patients read/update only permitted own records and patient-only write policies guard sessions/contacts; clinicians read only patient records explicitly assigned via `clinician_patient_access`. Profile role changes and clinician assignments cannot be self-granted; document authorized SQL/admin onboarding.
- A demo identity/data set is local, synthetic, and marked “Simulated”; it is not inserted into a real account's tables.
- Movement angles and symptoms are monitoring signals, not medical diagnosis, inflammation measurements, or treatment advice.
- ESP32 firmware and hardware instructions are source/documentation deliverables. No migration is applied to the remote Supabase project by this implementation; physical sensor, Wi-Fi, deployed HTTPS ingestion and policies must be verified by the owner in their Supabase project/device setup before collecting real records.

## Confirmation-first SOS extension

Add an account-only patient Profile section that stores one trusted contact's display name and E.164 phone number in a separate `trusted_emergency_contacts` table. Its RLS permits only that patient; clinicians receive no contact-data policy. An always-visible SOS control opens a confirmation dialog that names the saved contact and offers explicit **Call** and **Text** actions. Call opens the device dialer; Text opens an editable generic “I need help. Please contact me as soon as you can.” draft. The app does not place a call, auto-send a message, invoke location, or include health/session data. Demo mode cannot contact real people, a missing contact directs the user to Profile, and the app does not guess or hard-code a local emergency number. Document platform/device limitations and state that SOS supplements—not replaces—local emergency services.

## Project structure

- `frontend/`: Astro entry page and public files; `frontend/src/components/JointCareApp.tsx` contains the interactive patient dashboard and role views, and `frontend/src/styles/global.css` defines the responsive design system.
- `frontend/src/lib/` and `frontend/src/types/`: Supabase browser client, authorized data adapter, isolated simulated fixtures, transparent analytics and record types.
- `backend/app.py`: FastAPI ASGI entry, settings validation, Pydantic request schemas, Supabase REST adapter, auth/device verification, rate/body limits, routes, analysis and static frontend hosting; `backend/test_app.py` covers deterministic API contracts.
- `backend/requirements.txt` contains pinned development/test dependencies and `backend/requirements-prod.txt` is the smaller pinned runtime set; root `Dockerfile` builds the Astro client and runs FastAPI for production.
- `firmware/esp32_mpu6050/`: configurable ESP32/MPU6050 firmware example with local secret configuration excluded from Git.
- `supabase/migrations/`: additive SQL schema, constraints, triggers, RLS and policies; `supabase/seed.sql` is a safe no-op and cannot insert simulated rows into real accounts.
- `docs/`: API/setup, deployment, privacy/security, wiring, hardware validation and troubleshooting.
- Root `README.md`, `.env.example`, `plan.md`, and `TODO.md` document setup, build, decisions and delivery status.

## Design system

### Three candidate directions
- **Clinical instrument panel (0.07):** quiet typography, precision data markings and restrained lines.
- **Night-shift observatory (0.05):** dark ambient canvas and luminous signal accents.
- **Soft editorial journal (0.04):** paper-like record cards with expressive serif hierarchy.

Chosen: **Clinical instrument panel**, aligned with the user's explicit premium minimal monochrome dashboard reference.

- **Design Movement:** Contemporary Swiss data-dashboard design filtered through a clinical instrument panel.
- **Core Principles:** Clear hierarchy; precise but calm; private by default; simulated-versus-real provenance always visible.
- **Color Philosophy:** Near-black surfaces and layered charcoal borders keep the interface focused; warm white text supports legibility; muted grey carries secondary metadata; a controlled cool mint signal color marks active connection and positive completion without making a health claim. Warning/error states use accessible amber/red only for system/data quality status.
- **Layout Paradigm:** A persistent slim navigation rail anchors a spacious, vertically composed workbench. A broad primary trend surface is paired with a narrow context column; mobile collapses navigation into a bottom/slide-out pattern and stacks content in reading order.
- **Signature Elements:** Fine instrument ticks around movement-angle summaries; a persistent “SIMULATED” provenance chip on demo values; thin horizontal session timelines.
- **Interaction Philosophy:** Inputs confirm only after validation and saved state; charts expose exact values on keyboard-accessible focus/hover; hardware start/stop state is explicit, with recoverable connection errors and no silent transitions.
- **Animation:** Short 140–200 ms opacity/transform transitions for state changes; low-motion by default and `prefers-reduced-motion` support. Live chart traces update without bouncing or distracting continuous pulses.
- **Typography System:** Locally bundled Manrope for headings/body and DM Mono for sensor values, timestamps and device identifiers, with system sans/monospace fallbacks; use tabular numerals and restrained weight contrast.
- **Brand Essence:** A trustworthy movement-and-symptom notebook for patients and their clinicians, distinguished by transparent signal provenance; **calm, precise, respectful**.
- **Brand Voice:** Observational, plain English and non-diagnostic. Examples: “Your movement range is steady across the sessions shown.” “This pattern reflects the records available—not a diagnosis.”
- **Wordmark & Logo:** “JointCare” wordmark with a compact two-axis joint arc mark, evoking a measured range rather than a medical cross; use as site identity, not as a claim of clinical validation.
- **Signature Brand Color:** Muted glacier mint (`#8DD9C2`) used sparingly for active/live states.

## Implementation sequencing

1. Create a runnable, accessible UI foundation, navigation, routes, design tokens and route manifest.
2. Implement Supabase authentication and database setup documentation/migrations/RLS without exposing privileged credentials.
3. Connect profile, symptoms and dashboard to authorized Supabase records; demo data remains separately labeled.
4. Build FastAPI schemas, auth/device checks, sensor/session APIs, analytics, and API tests.
5. Implement simulated/live-monitoring UI and historical charts/reports/CSV/print flow.
6. Add firmware, board-specific configurable wiring guidance, privacy/security and clinician authorization onboarding documentation.
7. Configure one-container build/runtime, run available tests and type checks, start Preview, verify the route manifest and API health, and checkpoint the finished source. The user selected Manus-managed hosting, so submit a one-time publication after the checkpoint; do not enable the separate auto-publish preference.
