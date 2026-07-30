-- Self-service profiles for teachers/students and secure avatar uploads.

alter table public.profiles
  add column if not exists phone text not null default '',
  add column if not exists bio text not null default '',
  add column if not exists avatar_path text;

create or replace function public.can_edit_own_profile()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role in ('student', 'teacher')
  );
$$;

revoke all on function public.can_edit_own_profile() from public;
grant execute on function public.can_edit_own_profile() to authenticated;

create or replace function public.update_own_profile(
  p_first_name text,
  p_last_name text,
  p_grade text default null,
  p_no integer default null,
  p_phone text default '',
  p_bio text default '',
  p_avatar_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  viewer_id uuid := auth.uid();
  viewer_role text;
  old_full_name text;
  new_full_name text;
  saved_profile public.profiles%rowtype;
begin
  if viewer_id is null then
    raise exception 'Authentication required';
  end if;

  select role, trim(concat_ws(' ', first_name, last_name))
    into viewer_role, old_full_name
  from public.profiles
  where id = viewer_id;

  if viewer_role not in ('student', 'teacher') then
    raise exception 'Only teachers and students can edit this profile';
  end if;

  if char_length(trim(coalesce(p_first_name, ''))) not between 1 and 100
     or char_length(trim(coalesce(p_last_name, ''))) not between 1 and 100 then
    raise exception 'First name and last name are required';
  end if;

  if char_length(trim(coalesce(p_phone, ''))) > 30 then
    raise exception 'Phone number is too long';
  end if;

  if char_length(trim(coalesce(p_bio, ''))) > 500 then
    raise exception 'Bio is too long';
  end if;

  if viewer_role = 'student' and (
    char_length(trim(coalesce(p_grade, ''))) not between 1 and 30
    or p_no is null
    or p_no not between 1 and 999
  ) then
    raise exception 'Student grade and number are required';
  end if;

  if p_avatar_path is not null
     and p_avatar_path !~ ('^' || viewer_id::text || '/[A-Za-z0-9._-]+$') then
    raise exception 'Invalid avatar path';
  end if;

  new_full_name := trim(concat_ws(' ', trim(p_first_name), trim(p_last_name)));

  update public.profiles
  set first_name = trim(p_first_name),
      last_name = trim(p_last_name),
      grade = case when viewer_role = 'student' then trim(p_grade) else null end,
      no = case when viewer_role = 'student' then p_no else null end,
      phone = trim(coalesce(p_phone, '')),
      bio = trim(coalesce(p_bio, '')),
      avatar_path = nullif(trim(coalesce(p_avatar_path, '')), '')
  where id = viewer_id
  returning * into saved_profile;

  if viewer_role = 'student' then
    update public.student_projects
    set student_name = new_full_name
    where student_id = viewer_id;
  elsif viewer_role = 'teacher' and old_full_name is distinct from new_full_name then
    update public.student_projects
    set advisor = new_full_name
    where advisor = old_full_name;
  end if;

  return jsonb_build_object(
    'id', saved_profile.id,
    'first_name', saved_profile.first_name,
    'last_name', saved_profile.last_name,
    'role', saved_profile.role,
    'grade', saved_profile.grade,
    'no', saved_profile.no,
    'phone', saved_profile.phone,
    'bio', saved_profile.bio,
    'avatar_path', saved_profile.avatar_path
  );
end;
$$;

revoke all on function public.update_own_profile(text, text, text, integer, text, text, text) from public;
grant execute on function public.update_own_profile(text, text, text, integer, text, text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "profile_owners_upload_avatars" on storage.objects;
create policy "profile_owners_upload_avatars" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.can_edit_own_profile()
);

drop policy if exists "profile_owners_update_avatars" on storage.objects;
create policy "profile_owners_update_avatars" on storage.objects
for update to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.can_edit_own_profile()
)
with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.can_edit_own_profile()
);

drop policy if exists "profile_owners_delete_avatars" on storage.objects;
create policy "profile_owners_delete_avatars" on storage.objects
for delete to authenticated
using (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.can_edit_own_profile()
);

comment on function public.update_own_profile(text, text, text, integer, text, text, text) is
  'Lets teachers and students update only their own personal fields while keeping denormalized project names in sync.';
