-- Backfill Auth accounts created before JointCare's profile trigger existed.
-- Existing rows (including operator-managed clinician/admin roles) are never changed.
-- Missing profiles are provisioned as patients; Auth metadata cannot grant privileged roles.
insert into public.profiles (id, display_name, role)
select
  auth_user.id,
  nullif(left(coalesce(auth_user.raw_user_meta_data ->> 'display_name', ''), 160), ''),
  'patient'
from auth.users as auth_user
on conflict (id) do nothing;
