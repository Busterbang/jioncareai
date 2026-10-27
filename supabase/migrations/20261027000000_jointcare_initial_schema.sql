-- JointCare AI additive initial schema. Safe for first application: no DROP of tables/data.
-- Run once in the intended Supabase project. Privileged device and clinician provisioning is server/admin only.
create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end; $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (display_name is null or length(display_name) between 1 and 160),
  role text not null default 'patient' check (role in ('patient','clinician','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,display_name,role)
  values(new.id,nullif(left(coalesce(new.raw_user_meta_data ->> 'display_name',''),160),''),'patient')
  on conflict(id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created_jointcare on auth.users;
create trigger on_auth_user_created_jointcare after insert on auth.users for each row execute function public.handle_new_user();

create table if not exists public.patient_settings (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null unique references public.profiles(id) on delete cascade,
  monitored_joint text not null default 'Knee' check (length(monitored_joint) between 1 and 80),
  affected_side text not null default 'left' check (affected_side in ('left','right')),
  preferred_units text not null default 'metric' check (preferred_units in ('metric','imperial')),
  timezone text not null default 'UTC' check (length(timezone) between 1 and 64),
  notification_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trusted_emergency_contacts (
  patient_id uuid primary key references public.profiles(id) on delete cascade,
  contact_name text not null check (length(btrim(contact_name)) between 1 and 100),
  phone_e164 text not null check (phone_e164 ~ '^[+][1-9][0-9]{7,14}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sensor_devices (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.profiles(id) on delete cascade,
  device_identifier text not null unique check (length(device_identifier) between 1 and 128),
  device_type text not null default 'ESP32 + MPU6050' check (length(device_type) between 1 and 100),
  access_token_hash text not null unique check (length(access_token_hash) = 64),
  is_active boolean not null default true,
  status text not null default 'inactive' check (status in ('active','inactive','revoked')),
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.monitoring_sessions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.profiles(id) on delete cascade,
  device_id uuid references public.sensor_devices(id) on delete set null,
  mode text not null default 'real' check (mode in ('real','demo')),
  status text not null default 'active' check (status in ('active','paused','completed','cancelled')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  notes text check (notes is null or length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at),
  check ((status in ('active','paused') and ended_at is null) or status in ('completed','cancelled'))
);

create table if not exists public.sensor_readings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.monitoring_sessions(id) on delete cascade,
  patient_id uuid not null references public.profiles(id) on delete cascade,
  device_id uuid references public.sensor_devices(id) on delete set null,
  measured_at timestamptz not null,
  accel_x double precision not null check (accel_x between -200 and 200),
  accel_y double precision not null check (accel_y between -200 and 200),
  accel_z double precision not null check (accel_z between -200 and 200),
  gyro_x double precision not null check (gyro_x between -4000 and 4000),
  gyro_y double precision not null check (gyro_y between -4000 and 4000),
  gyro_z double precision not null check (gyro_z between -4000 and 4000),
  relative_angle_degrees double precision check (relative_angle_degrees between -180 and 180),
  source text not null default 'device' check (source in ('device','patient','simulated_demo_only')),
  quality text not null default 'unknown' check (quality in ('unknown','valid','low','invalid')),
  created_at timestamptz not null default now()
);

create table if not exists public.symptom_records (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.profiles(id) on delete cascade,
  recorded_at timestamptz not null default now(),
  joint text not null check (length(joint) between 1 and 80),
  pain_score smallint not null check (pain_score between 0 and 10),
  stiffness_score smallint not null check (stiffness_score between 0 and 10),
  swelling boolean not null default false,
  discomfort text check (discomfort is null or length(discomfort) <= 500),
  activity text check (activity is null or length(activity) <= 120),
  notes text check (notes is null or length(notes) <= 2000),
  source text not null default 'patient' check (source in ('patient','device','simulated_demo_only')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Authenticated clients cannot forge symptom provenance; trusted server-role
-- operations may retain an explicitly assigned source label.
create or replace function public.jointcare_force_patient_symptom_source()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    new.source := 'patient';
  end if;
  return new;
end;
$$;
revoke all on function public.jointcare_force_patient_symptom_source() from public;
drop trigger if exists jointcare_force_patient_symptom_source on public.symptom_records;
create trigger jointcare_force_patient_symptom_source
before insert or update on public.symptom_records
for each row execute function public.jointcare_force_patient_symptom_source();

create table if not exists public.analysis_results (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid references public.monitoring_sessions(id) on delete set null,
  window_start timestamptz,
  window_end timestamptz,
  summary text not null check (length(summary) between 1 and 2000),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  quality jsonb not null default '{}'::jsonb check (jsonb_typeof(quality) = 'object'),
  source text not null default 'rule_based' check (source in ('rule_based','simulated_demo_only')),
  generated_at timestamptz not null default now(),
  model_version text check (model_version is null or length(model_version) <= 100),
  created_at timestamptz not null default now(),
  check (window_end is null or window_start is null or window_end >= window_start)
);

create table if not exists public.clinician_patient_access (
  id uuid primary key default gen_random_uuid(),
  clinician_id uuid not null references public.profiles(id) on delete cascade,
  patient_id uuid not null references public.profiles(id) on delete cascade,
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  check (clinician_id <> patient_id),
  check (expires_at is null or expires_at > granted_at),
  unique (clinician_id,patient_id)
);

create index if not exists sensor_devices_patient_idx on public.sensor_devices(patient_id);
create index if not exists sensor_devices_hash_active_idx on public.sensor_devices(access_token_hash,is_active);
create index if not exists monitoring_sessions_patient_started_idx on public.monitoring_sessions(patient_id,started_at desc);
create index if not exists sensor_readings_patient_time_idx on public.sensor_readings(patient_id,measured_at desc);
create index if not exists sensor_readings_session_time_idx on public.sensor_readings(session_id,measured_at desc);
create index if not exists symptom_records_patient_time_idx on public.symptom_records(patient_id,recorded_at desc);
create index if not exists analysis_results_patient_time_idx on public.analysis_results(patient_id,generated_at desc);
create index if not exists clinician_patient_access_pair_idx on public.clinician_patient_access(clinician_id,patient_id);

create or replace function public.jointcare_is_assigned(p_patient uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.clinician_patient_access a where a.patient_id=p_patient and a.clinician_id=(select auth.uid()) and (a.expires_at is null or a.expires_at > now()))
$$;
revoke all on function public.jointcare_is_assigned(uuid) from public;
grant execute on function public.jointcare_is_assigned(uuid) to authenticated;

create or replace function public.jointcare_is_patient()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.role='patient')
$$;
revoke all on function public.jointcare_is_patient() from public;
grant execute on function public.jointcare_is_patient() to authenticated;

-- Recreate only this app's named timestamp triggers so rerunning the migration is safe.
do $$ declare t text; begin
  foreach t in array array['profiles','patient_settings','trusted_emergency_contacts','sensor_devices','monitoring_sessions','symptom_records'] loop
    execute format('drop trigger if exists set_updated_at on public.%I',t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()',t);
  end loop;
end $$;

alter table public.profiles enable row level security;
alter table public.patient_settings enable row level security;
alter table public.trusted_emergency_contacts enable row level security;
alter table public.sensor_devices enable row level security;
alter table public.monitoring_sessions enable row level security;
alter table public.sensor_readings enable row level security;
alter table public.symptom_records enable row level security;
alter table public.analysis_results enable row level security;
alter table public.clinician_patient_access enable row level security;

drop policy if exists profiles_read_self_or_assigned on public.profiles;
drop policy if exists profiles_update_self_patient_only on public.profiles;
drop policy if exists settings_read_own_or_assigned on public.patient_settings;
drop policy if exists settings_insert_own on public.patient_settings;
drop policy if exists settings_update_own on public.patient_settings;
drop policy if exists settings_delete_own on public.patient_settings;
drop policy if exists trusted_contacts_read_own on public.trusted_emergency_contacts;
drop policy if exists trusted_contacts_insert_own on public.trusted_emergency_contacts;
drop policy if exists trusted_contacts_update_own on public.trusted_emergency_contacts;
drop policy if exists trusted_contacts_delete_own on public.trusted_emergency_contacts;
drop policy if exists sessions_read_own_or_assigned on public.monitoring_sessions;
drop policy if exists sessions_insert_own on public.monitoring_sessions;
drop policy if exists sessions_update_own on public.monitoring_sessions;
drop policy if exists sessions_delete_own on public.monitoring_sessions;
drop policy if exists readings_read_own_or_assigned on public.sensor_readings;
drop policy if exists symptoms_read_own_or_assigned on public.symptom_records;
drop policy if exists symptoms_insert_own on public.symptom_records;
drop policy if exists symptoms_update_own on public.symptom_records;
drop policy if exists symptoms_delete_own on public.symptom_records;
drop policy if exists analysis_read_own_or_assigned on public.analysis_results;
drop policy if exists access_read_participants on public.clinician_patient_access;

create policy profiles_read_self_or_assigned on public.profiles for select to authenticated using (id=(select auth.uid()) or public.jointcare_is_assigned(id));
create policy profiles_update_self_patient_only on public.profiles for update to authenticated using(id=(select auth.uid()) and role='patient') with check(id=(select auth.uid()) and role='patient');

create policy settings_read_own_or_assigned on public.patient_settings for select to authenticated using(patient_id=(select auth.uid()) or public.jointcare_is_assigned(patient_id));
create policy settings_insert_own on public.patient_settings for insert to authenticated with check(patient_id=(select auth.uid()));
create policy settings_update_own on public.patient_settings for update to authenticated using(patient_id=(select auth.uid())) with check(patient_id=(select auth.uid()));
create policy settings_delete_own on public.patient_settings for delete to authenticated using(patient_id=(select auth.uid()));

-- Trusted-contact PII is private to the patient; there are deliberately no clinician policies.
revoke all on table public.trusted_emergency_contacts from anon, public;
grant select, insert, update, delete on table public.trusted_emergency_contacts to authenticated;
create policy trusted_contacts_read_own on public.trusted_emergency_contacts for select to authenticated using(patient_id=(select auth.uid()) and (select public.jointcare_is_patient()));
create policy trusted_contacts_insert_own on public.trusted_emergency_contacts for insert to authenticated with check(patient_id=(select auth.uid()) and (select public.jointcare_is_patient()));
create policy trusted_contacts_update_own on public.trusted_emergency_contacts for update to authenticated using(patient_id=(select auth.uid()) and (select public.jointcare_is_patient())) with check(patient_id=(select auth.uid()) and (select public.jointcare_is_patient()));
create policy trusted_contacts_delete_own on public.trusted_emergency_contacts for delete to authenticated using(patient_id=(select auth.uid()) and (select public.jointcare_is_patient()));

-- No authenticated-client policy for device registry. Trusted service-role backend only.
create policy sessions_read_own_or_assigned on public.monitoring_sessions for select to authenticated using(patient_id=(select auth.uid()) or public.jointcare_is_assigned(patient_id));
create policy sessions_insert_own on public.monitoring_sessions for insert to authenticated with check(patient_id=(select auth.uid()) and (select public.jointcare_is_patient()));
create policy sessions_update_own on public.monitoring_sessions for update to authenticated using(patient_id=(select auth.uid()) and (select public.jointcare_is_patient())) with check(patient_id=(select auth.uid()) and (select public.jointcare_is_patient()));
create policy sessions_delete_own on public.monitoring_sessions for delete to authenticated using(patient_id=(select auth.uid()) and (select public.jointcare_is_patient()));

create policy readings_read_own_or_assigned on public.sensor_readings for select to authenticated using(patient_id=(select auth.uid()) or public.jointcare_is_assigned(patient_id));
-- No authenticated-client write policy for sensor samples; ingestion is server-only.
create policy symptoms_read_own_or_assigned on public.symptom_records for select to authenticated using(patient_id=(select auth.uid()) or public.jointcare_is_assigned(patient_id));
create policy symptoms_insert_own on public.symptom_records for insert to authenticated with check(patient_id=(select auth.uid()));
create policy symptoms_update_own on public.symptom_records for update to authenticated using(patient_id=(select auth.uid())) with check(patient_id=(select auth.uid()));
create policy symptoms_delete_own on public.symptom_records for delete to authenticated using(patient_id=(select auth.uid()));

create policy analysis_read_own_or_assigned on public.analysis_results for select to authenticated using(patient_id=(select auth.uid()) or public.jointcare_is_assigned(patient_id));
-- Analysis is server-generated; no authenticated-client write policy.
create policy access_read_participants on public.clinician_patient_access for select to authenticated using(clinician_id=(select auth.uid()) or patient_id=(select auth.uid()));
-- No client grant/revoke policy. The service-role backend is the trusted assignment path.

comment on table public.sensor_devices is 'Trusted-server managed device registry; no authenticated client policies.';
comment on table public.sensor_readings is 'Observed sensor records; use server ingestion; relative angles are not clinical ranges.';
comment on table public.clinician_patient_access is 'Trusted operator-managed explicit clinician access assignments.';
comment on table public.trusted_emergency_contacts is 'Patient-only trusted contact for confirmation-first call/text links; not visible to clinicians.';
comment on table public.analysis_results is 'Explainable summaries, not clinical diagnosis or medication advice.';
