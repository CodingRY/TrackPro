-- TrackPro learning lessons, secure watch-time accumulation, and advisor reports.

create table if not exists public.learning_lessons (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 1 and 160),
  description text not null default '',
  youtube_url text not null,
  youtube_video_id text not null check (youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  duration_seconds integer not null check (duration_seconds > 0 and duration_seconds <= 86400),
  sort_order integer not null default 0,
  is_published boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.learning_progress (
  student_id uuid not null references public.profiles(id) on delete cascade,
  lesson_id uuid not null references public.learning_lessons(id) on delete cascade,
  watched_seconds integer not null default 0 check (watched_seconds >= 0),
  last_position_seconds integer not null default 0 check (last_position_seconds >= 0),
  completed boolean not null default false,
  last_recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (student_id, lesson_id)
);

create index if not exists learning_lessons_order_idx
  on public.learning_lessons (is_published, sort_order, created_at);
create index if not exists learning_progress_student_idx
  on public.learning_progress (student_id, updated_at desc);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.is_teacher_or_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid() and role in ('teacher', 'admin')
  );
$$;

create or replace function public.teacher_advises_student(target_student_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  viewer_role text;
  teacher_name text;
begin
  select role, trim(concat_ws(' ', first_name, last_name))
    into viewer_role, teacher_name
  from public.profiles
  where id = auth.uid();

  if viewer_role = 'admin' then
    return true;
  end if;

  if viewer_role is distinct from 'teacher' then
    return false;
  end if;

  return exists (
    select 1
    from public.student_projects sp
    where sp.advisor = teacher_name
      and (
        sp.student_id = target_student_id
        or exists (
          select 1
          from public.project_member pm
          where pm.project_id = sp.id
            and pm.student_id = target_student_id
        )
      )
  );
end;
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.is_teacher_or_admin() from public;
revoke all on function public.teacher_advises_student(uuid) from public;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_teacher_or_admin() to authenticated;
grant execute on function public.teacher_advises_student(uuid) to authenticated;

alter table public.learning_lessons enable row level security;
alter table public.learning_progress enable row level security;

drop policy if exists "authenticated_read_learning_lessons" on public.learning_lessons;
create policy "authenticated_read_learning_lessons" on public.learning_lessons
for select to authenticated
using (is_published or public.is_teacher_or_admin());

drop policy if exists "teachers_create_learning_lessons" on public.learning_lessons;
drop policy if exists "admins_create_learning_lessons" on public.learning_lessons;
create policy "admins_create_learning_lessons" on public.learning_lessons
for insert to authenticated
with check (public.is_admin() and created_by = auth.uid());

drop policy if exists "lesson_owners_update_learning_lessons" on public.learning_lessons;
drop policy if exists "admins_update_learning_lessons" on public.learning_lessons;
create policy "admins_update_learning_lessons" on public.learning_lessons
for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "lesson_owners_delete_learning_lessons" on public.learning_lessons;
drop policy if exists "admins_delete_learning_lessons" on public.learning_lessons;
create policy "admins_delete_learning_lessons" on public.learning_lessons
for delete to authenticated
using (public.is_admin());

drop policy if exists "students_and_advisors_read_learning_progress" on public.learning_progress;
create policy "students_and_advisors_read_learning_progress" on public.learning_progress
for select to authenticated
using (
  student_id = auth.uid()
  or public.teacher_advises_student(student_id)
);

grant select, insert, update, delete on public.learning_lessons to authenticated;
grant select on public.learning_progress to authenticated;

create or replace function public.record_learning_progress(
  p_lesson_id uuid,
  p_delta_seconds integer,
  p_position_seconds integer
)
returns public.learning_progress
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student_id uuid := auth.uid();
  v_role text;
  v_duration integer;
  v_delta integer := greatest(0, least(coalesce(p_delta_seconds, 0), 10));
  v_position integer;
  v_elapsed_allowance integer;
  v_existing public.learning_progress%rowtype;
  v_result public.learning_progress%rowtype;
begin
  if v_student_id is null then
    raise exception 'Authentication required';
  end if;

  select role into v_role
  from public.profiles
  where id = v_student_id;

  if v_role is distinct from 'student' then
    raise exception 'Only students can record learning progress';
  end if;

  select duration_seconds into v_duration
  from public.learning_lessons
  where id = p_lesson_id and is_published = true;

  if v_duration is null then
    raise exception 'Lesson not found or unpublished';
  end if;

  v_position := greatest(0, least(coalesce(p_position_seconds, 0), v_duration));

  select * into v_existing
  from public.learning_progress
  where student_id = v_student_id and lesson_id = p_lesson_id
  for update;

  if found then
    v_elapsed_allowance := greatest(
      0,
      least(10, floor(extract(epoch from (now() - v_existing.last_recorded_at)))::integer + 1)
    );
    v_delta := least(v_delta, v_elapsed_allowance);

    update public.learning_progress
    set watched_seconds = least(v_duration, watched_seconds + v_delta),
        last_position_seconds = v_position,
        completed = least(v_duration, watched_seconds + v_delta)
          >= ceil(v_duration * 0.9)::integer,
        last_recorded_at = now(),
        updated_at = now()
    where student_id = v_student_id and lesson_id = p_lesson_id
    returning * into v_result;
  else
    insert into public.learning_progress (
      student_id,
      lesson_id,
      watched_seconds,
      last_position_seconds,
      completed
    ) values (
      v_student_id,
      p_lesson_id,
      least(v_duration, v_delta),
      v_position,
      least(v_duration, v_delta) >= ceil(v_duration * 0.9)::integer
    )
    returning * into v_result;
  end if;

  return v_result;
end;
$$;

revoke all on function public.record_learning_progress(uuid, integer, integer) from public;
grant execute on function public.record_learning_progress(uuid, integer, integer) to authenticated;

create or replace function public.get_advised_learning_students()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  viewer_role text;
  teacher_name text;
  result jsonb;
begin
  select role, trim(concat_ws(' ', first_name, last_name))
    into viewer_role, teacher_name
  from public.profiles
  where id = auth.uid();

  if viewer_role is distinct from 'teacher' then
    raise exception 'Only teachers can view advised student reports';
  end if;

  with advised_projects as (
    select sp.student_id, sp.title
    from public.student_projects sp
    where sp.advisor = teacher_name
    union all
    select pm.student_id, sp.title
    from public.student_projects sp
    join public.project_member pm on pm.project_id = sp.id
    where sp.advisor = teacher_name
  ), students as (
    select
      p.id,
      p.first_name,
      p.last_name,
      p.grade,
      p.no,
      array_agg(distinct ap.title order by ap.title) as project_titles
    from advised_projects ap
    join public.profiles p on p.id = ap.student_id and p.role = 'student'
    group by p.id, p.first_name, p.last_name, p.grade, p.no
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'first_name', first_name,
        'last_name', last_name,
        'grade', grade,
        'no', no,
        'project_titles', to_jsonb(project_titles)
      ) order by first_name, last_name
    ),
    '[]'::jsonb
  ) into result
  from students;

  return result;
end;
$$;

revoke all on function public.get_advised_learning_students() from public;
grant execute on function public.get_advised_learning_students() to authenticated;

comment on table public.learning_lessons is
  'YouTube lessons created by teachers and administrators.';
comment on table public.learning_progress is
  'Server-controlled accumulated watch time for each student and lesson.';
comment on function public.record_learning_progress(uuid, integer, integer) is
  'Securely adds a bounded playback interval for the signed-in student.';
comment on function public.get_advised_learning_students() is
  'Returns students who lead or belong to projects advised by the signed-in teacher.';

notify pgrst, 'reload schema';
