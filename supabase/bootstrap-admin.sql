-- 1. Register this email through TrackPro first.
-- 2. Replace admin@example.com below with the real admin email.
-- 3. Run this script once in the Supabase SQL Editor.

do $$
declare
  target_user_id uuid;
begin
  select id into target_user_id
  from auth.users
  where lower(email) = lower('admin@example.com');

  if target_user_id is null then
    raise exception 'No Auth account found for the supplied admin email';
  end if;

  update public.profiles
  set role = 'admin'
  where id = target_user_id;

  if not found then
    raise exception 'The Auth account has no matching profile row';
  end if;
end $$;
