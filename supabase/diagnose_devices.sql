-- Run in the Supabase SQL editor (service role). Read-only until you uncomment the UPDATEs.
-- 1) Which existing rows exist, who owns them, and are they usable by the ingest route?
select d.id, d.device_identifier, d.patient_id, d.is_active, d.status, d.last_seen_at,
       length(d.access_token_hash) as hash_len,   -- must be 64
       (select count(*) from public.monitoring_sessions s where s.device_id = d.id and s.status = 'active') as active_sessions
from public.sensor_devices d
where d.device_identifier in ('esp32001', 'ESP32_001', 'esp32-motion-01');

-- 2) Ingest requires is_active = true AND status = 'active' (schema default for status is 'inactive').
-- update public.sensor_devices set is_active = true, status = 'active' where device_identifier = 'ESP32_001';

-- 3) Retire the duplicate so only one identifier is used (revoked rows are rejected with HTTP 403).
-- update public.sensor_devices set is_active = false, status = 'revoked' where device_identifier = 'esp32001';

-- 4) Tokens cannot be recovered. Get a new one with POST /api/v1/sensor/devices/rotate-token
--    (signed in as the owning patient) rather than writing a hash by hand.
