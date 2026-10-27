# Security and privacy notes

JointCare AI can store sensitive movement and user-reported symptom information. Use a separate non-production Supabase project and synthetic identities while testing. This repository is not a privacy/regulatory certification or substitute for a jurisdiction-specific review.

## Data flow and purpose

- Supabase Auth holds account identity; the browser uses a Supabase publishable key and user access token. The database's row-level security policies authorize every account query/write.
- The FastAPI server validates user tokens with Supabase and accepts the service-role credential only for narrowly server-side hardware provisioning/ingest and account deletion. The privileged key is not returned from `/jointcare-config.js` and must never be bundled or shared.
- A device token is generated on enrollment, displayed once, HMAC-digested on the server with a distinct private device key, and checked against an enrolled device and active session before sensor rows are inserted. A separate strong `DEVICE_AUTH_SECRET` may be configured; if it is absent, weak, or overlaps a public Supabase key, the backend derives a domain-separated HMAC key from the server-only service-role credential. Never use a publishable key as the device signing key. Store device tokens only in local ignored firmware `secrets.h`; changing the signing key invalidates prior tokens, so disable/re-enroll affected devices.
- Simulated demo records use a visible demo workspace and browser-local storage. They are not sent to Supabase, mixed into account charts, or used as real measurements. Do not log in with real patient data for a demo.
- A patient may save one trusted contact in `trusted_emergency_contacts`. Its RLS is patient-owner-only, without an assigned-clinician policy; clinicians do not load this table. SOS requires a confirmation choice before opening the operating system's phone (`tel:`) or message (`sms:`) handler. The message is a generic editable draft, not auto-sent. The app does not attach or transmit GPS location, sensor readings, symptoms, health/session data, or account identity.
- SOS is unavailable for real calls/texts in simulated demo mode. The app does not guess a region or emergency number and cannot guarantee native dialer/SMS support; this convenience does not replace contacting local emergency services.
- The rule-based summary reads stored movement and symptom values and uses no external AI provider. It is descriptive; correlation does not establish causality.

## Database access

RLS is the primary patient/clinician record boundary. Patients can view their own permitted records; clinician reads require an active explicit `clinician_patient_access` assignment. New profiles default to the patient role, and users cannot self-grant a clinician/admin role or assignment. Device registry, sample writes, analysis writes and assignment changes have no authenticated-client write policy and are reserved for the trusted server/operator path. Review the migration before applying it to an existing project.

The service-role key bypasses RLS. Treat it as highly privileged: set it only in the protected server environment, scope access to deployment administrators, rotate it when exposed, never write it into a `PUBLIC_` variable, frontend asset, source-control secret, firmware or client log.

## Transport, input and operations

Use authenticated HTTPS for deployed web/API and ESP32 traffic. The sketch verifies the TLS certificate; do not disable that check or downgrade to plain HTTP. API schemas reject unexpected fields and bound sensor batch size, value range and timestamp timezone. The API declares a body-size check and process-local rate limits; configure gateway/shared limits too when horizontally scaling. Do not assume an in-memory rate limiter is a distributed quota.

Delete the account only after exporting anything the user needs: the UI confirms before the privileged account deletion route, and the schema cascades associated application records. Establish an explicit retention, revocation, backup and restoration process for the Supabase project outside the application. Limit access to backups as carefully as live data.

## Clinical limits

An MPU6050 reports acceleration and angular velocity. This app's example angle is a relative orientation signal with a simple stationary reference calibration; it is not a clinically defined joint range, does not detect inflammation and cannot diagnose disease or advise treatment. Missing values, orientation changes, mounting and noise can make comparisons misleading. Consult an appropriately qualified clinician for medical interpretation.

## Before collecting real data

- Verify the correct Supabase project, migration, Auth redirect settings and RLS with synthetic test accounts.
- Verify operator-only clinician role and assignment provisioning/revocation.
- Verify service secrets never appear in a built asset, route response, log or firmware repository.
- Verify TLS, device-token rotation, session ownership, gateway body/rate controls and recovery/deletion operations.
- Obtain any consent, governance, safety, privacy and regulatory review required for your actual deployment and population.
