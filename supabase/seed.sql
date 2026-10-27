-- JointCare AI synthetic seed mode: intentionally inserts no rows by default.
-- This avoids creating fake identities or writing fabricated data into any real user's records.
--
-- To exercise the schema, create dedicated test accounts through Supabase Auth in a non-production
-- project. The auth.users trigger creates each profile with role='patient'. Then, using a trusted
-- server/service-role connection only, populate settings/sessions/readings/symptoms for those
-- dedicated test accounts and mark every fixture synthetic (for example in notes/metadata).
-- Never use real patient identities or production user IDs for fixture data. Do not grant clinician
-- role/access from an untrusted client. No clinical validity is implied by test data.
select 'Synthetic seed mode is safe/no-op; use dedicated non-production Auth test accounts.' as seed_status;
