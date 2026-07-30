-- TrackPro admin authorization and role protection

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create or replace function public.protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- SQL Editor and trusted database maintenance run without JWT claims.
  if auth.role() is null then
    return new;
  end if;

  if tg_op = 'INSERT'
     and new.role = 'admin'
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Admin accounts must be created by a server administrator';
  end if;

  if tg_op = 'UPDATE'
     and new.role is distinct from old.role
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.is_admin() then
    raise exception 'Only an admin can change account roles';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_profile_role_trigger on public.profiles;
create trigger protect_profile_role_trigger
before insert or update of role on public.profiles
for each row execute function public.protect_profile_role();

alter table public.profiles enable row level security;
alter table public.student_projects enable row level security;
alter table public.project_member enable row level security;
alter table public.community_posts enable row level security;

drop policy if exists "admin_profiles_all" on public.profiles;
create policy "admin_profiles_all" on public.profiles
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "admin_projects_all" on public.student_projects;
create policy "admin_projects_all" on public.student_projects
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "admin_project_members_all" on public.project_member;
create policy "admin_project_members_all" on public.project_member
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "admin_community_posts_all" on public.community_posts;
create policy "admin_community_posts_all" on public.community_posts
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

comment on function public.is_admin() is 'Returns true only when the current authenticated user has the admin profile role.';
