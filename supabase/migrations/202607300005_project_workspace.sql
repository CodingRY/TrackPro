-- Per-project workspace: ordered tasks, submission revisions, advisor review, chat, and private files.

create table if not exists public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id bigint not null references public.student_projects(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 160),
  instructions text not null default '',
  sort_order integer not null check (sort_order > 0),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, sort_order)
);

create table if not exists public.project_submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.project_tasks(id) on delete cascade,
  project_id bigint not null references public.student_projects(id) on delete cascade,
  submitted_by uuid not null references public.profiles(id) on delete restrict,
  version integer not null check (version > 0),
  message text not null default '',
  file_path text,
  file_name text,
  mime_type text,
  file_size bigint check (file_size is null or (file_size >= 0 and file_size <= 20971520)),
  status text not null default 'submitted' check (status in ('submitted', 'revision_requested', 'passed')),
  teacher_feedback text not null default '',
  reviewed_by uuid references public.profiles(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, version),
  check (nullif(trim(message), '') is not null or file_path is not null)
);

create table if not exists public.project_messages (
  id uuid primary key default gen_random_uuid(),
  project_id bigint not null references public.student_projects(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete restrict,
  body text not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists project_tasks_project_order_idx
  on public.project_tasks (project_id, sort_order);
create index if not exists project_submissions_task_version_idx
  on public.project_submissions (task_id, version desc);
create index if not exists project_messages_project_created_idx
  on public.project_messages (project_id, created_at);

create or replace function public.is_project_advisor(target_project_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.student_projects sp
    join public.profiles p on p.id = auth.uid()
    where sp.id = target_project_id
      and p.role = 'teacher'
      and trim(concat_ws(' ', p.first_name, p.last_name)) = sp.advisor
  );
$$;

create or replace function public.is_project_student(target_project_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.student_projects sp
    where sp.id = target_project_id
      and (
        sp.student_id = auth.uid()
        or exists (
          select 1 from public.project_member pm
          where pm.project_id = sp.id and pm.student_id = auth.uid()
        )
      )
  );
$$;

create or replace function public.can_access_project(target_project_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or public.is_project_advisor(target_project_id)
    or public.is_project_student(target_project_id);
$$;

revoke all on function public.is_project_advisor(bigint) from public;
revoke all on function public.is_project_student(bigint) from public;
revoke all on function public.can_access_project(bigint) from public;
grant execute on function public.is_project_advisor(bigint) to authenticated;
grant execute on function public.is_project_student(bigint) to authenticated;
grant execute on function public.can_access_project(bigint) to authenticated;

alter table public.project_tasks enable row level security;
alter table public.project_submissions enable row level security;
alter table public.project_messages enable row level security;

drop policy if exists "project_participants_read_tasks" on public.project_tasks;
create policy "project_participants_read_tasks" on public.project_tasks
for select to authenticated using (public.can_access_project(project_id));

drop policy if exists "project_participants_read_submissions" on public.project_submissions;
create policy "project_participants_read_submissions" on public.project_submissions
for select to authenticated using (public.can_access_project(project_id));

drop policy if exists "project_participants_read_messages" on public.project_messages;
create policy "project_participants_read_messages" on public.project_messages
for select to authenticated using (public.can_access_project(project_id));

grant select on public.project_tasks, public.project_submissions, public.project_messages to authenticated;

create or replace function public.recalculate_project_task_progress(target_project_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  task_total integer;
  task_passed integer;
  calculated_progress integer;
begin
  select count(*)::integer,
         count(*) filter (
           where exists (
             select 1 from public.project_submissions ps
             where ps.task_id = pt.id and ps.status = 'passed'
           )
         )::integer
    into task_total, task_passed
  from public.project_tasks pt
  where pt.project_id = target_project_id;

  calculated_progress := case
    when task_total = 0 then 0
    else round(task_passed * 100.0 / task_total)::integer
  end;

  update public.student_projects
  set progress = calculated_progress
  where id = target_project_id;

  return calculated_progress;
end;
$$;

revoke all on function public.recalculate_project_task_progress(bigint) from public;

create or replace function public.sync_project_progress_after_task_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recalculate_project_task_progress(old.project_id);
    return old;
  end if;

  perform public.recalculate_project_task_progress(new.project_id);
  return new;
end;
$$;

drop trigger if exists sync_project_progress_after_task_change_trigger on public.project_tasks;
create trigger sync_project_progress_after_task_change_trigger
after insert or delete on public.project_tasks
for each row execute function public.sync_project_progress_after_task_change();

create or replace function public.add_project_task(
  p_project_id bigint,
  p_title text,
  p_instructions text default ''
)
returns public.project_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  next_order integer;
  result public.project_tasks%rowtype;
begin
  if not public.is_project_advisor(p_project_id) then
    raise exception 'Only the assigned advisor can add project tasks';
  end if;
  if nullif(trim(p_title), '') is null then
    raise exception 'Task title is required';
  end if;

  perform pg_advisory_xact_lock(p_project_id);
  select coalesce(max(sort_order), 0) + 1 into next_order
  from public.project_tasks where project_id = p_project_id;

  insert into public.project_tasks (project_id, title, instructions, sort_order, created_by)
  values (p_project_id, trim(p_title), coalesce(trim(p_instructions), ''), next_order, auth.uid())
  returning * into result;

  return result;
end;
$$;

create or replace function public.update_project_task(
  p_task_id uuid,
  p_title text,
  p_instructions text default ''
)
returns public.project_tasks
language plpgsql
security definer
set search_path = public
as $$
declare
  target_project_id bigint;
  result public.project_tasks%rowtype;
begin
  select project_id into target_project_id from public.project_tasks where id = p_task_id;
  if target_project_id is null or not public.is_project_advisor(target_project_id) then
    raise exception 'Only the assigned advisor can update this task';
  end if;
  if nullif(trim(p_title), '') is null then
    raise exception 'Task title is required';
  end if;

  update public.project_tasks
  set title = trim(p_title),
      instructions = coalesce(trim(p_instructions), ''),
      updated_at = now()
  where id = p_task_id
  returning * into result;
  return result;
end;
$$;

create or replace function public.delete_project_task(p_task_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_project_id bigint;
begin
  select project_id into target_project_id from public.project_tasks where id = p_task_id;
  if target_project_id is null or not public.is_project_advisor(target_project_id) then
    raise exception 'Only the assigned advisor can delete this task';
  end if;
  delete from public.project_tasks where id = p_task_id;
  return found;
end;
$$;

create or replace function public.submit_project_task(
  p_task_id uuid,
  p_message text default '',
  p_file_path text default null,
  p_file_name text default null,
  p_mime_type text default null,
  p_file_size bigint default null
)
returns public.project_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  task_record public.project_tasks%rowtype;
  latest_status text;
  next_version integer;
  result public.project_submissions%rowtype;
begin
  select * into task_record from public.project_tasks where id = p_task_id;
  if task_record.id is null or not public.is_project_student(task_record.project_id) then
    raise exception 'Only project students can submit this task';
  end if;
  if nullif(trim(p_message), '') is null and p_file_path is null then
    raise exception 'Add a message or attach a file';
  end if;
  if p_file_size is not null and (p_file_size < 0 or p_file_size > 20971520) then
    raise exception 'File is larger than 20 MB';
  end if;
  if p_file_path is not null and p_file_path not like
    task_record.project_id::text || '/' || auth.uid()::text || '/%' then
    raise exception 'Invalid submission file path';
  end if;

  if exists (
    select 1
    from public.project_tasks previous_task
    where previous_task.project_id = task_record.project_id
      and previous_task.sort_order < task_record.sort_order
      and not exists (
        select 1 from public.project_submissions passed_submission
        where passed_submission.task_id = previous_task.id
          and passed_submission.status = 'passed'
      )
  ) then
    raise exception 'Complete the previous task first';
  end if;

  select status into latest_status
  from public.project_submissions
  where task_id = p_task_id
  order by version desc limit 1;

  if latest_status = 'submitted' then
    raise exception 'This task is waiting for advisor review';
  elsif latest_status = 'passed' then
    raise exception 'This task has already passed';
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.project_submissions where task_id = p_task_id;

  insert into public.project_submissions (
    task_id, project_id, submitted_by, version, message,
    file_path, file_name, mime_type, file_size
  ) values (
    p_task_id, task_record.project_id, auth.uid(), next_version,
    coalesce(trim(p_message), ''), p_file_path, p_file_name, p_mime_type, p_file_size
  ) returning * into result;

  return result;
end;
$$;

create or replace function public.review_project_submission(
  p_submission_id uuid,
  p_decision text,
  p_feedback text default ''
)
returns public.project_submissions
language plpgsql
security definer
set search_path = public
as $$
declare
  submission_record public.project_submissions%rowtype;
  result public.project_submissions%rowtype;
begin
  select * into submission_record
  from public.project_submissions
  where id = p_submission_id
  for update;

  if submission_record.id is null or not public.is_project_advisor(submission_record.project_id) then
    raise exception 'Only the assigned advisor can review this submission';
  end if;
  if submission_record.status <> 'submitted' then
    raise exception 'This submission has already been reviewed';
  end if;
  if p_decision not in ('revision_requested', 'passed') then
    raise exception 'Invalid review decision';
  end if;
  if p_decision = 'revision_requested' and nullif(trim(p_feedback), '') is null then
    raise exception 'Feedback is required when requesting a revision';
  end if;

  update public.project_submissions
  set status = p_decision,
      teacher_feedback = coalesce(trim(p_feedback), ''),
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  where id = p_submission_id
  returning * into result;

  perform public.recalculate_project_task_progress(submission_record.project_id);
  return result;
end;
$$;

create or replace function public.send_project_message(
  p_project_id bigint,
  p_body text
)
returns public.project_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.project_messages%rowtype;
begin
  if not (
    public.is_project_advisor(p_project_id)
    or public.is_project_student(p_project_id)
  ) then
    raise exception 'Only project participants can send messages';
  end if;
  if nullif(trim(p_body), '') is null or char_length(trim(p_body)) > 2000 then
    raise exception 'Message must contain between 1 and 2000 characters';
  end if;

  insert into public.project_messages (project_id, sender_id, body)
  values (p_project_id, auth.uid(), trim(p_body))
  returning * into result;
  return result;
end;
$$;

create or replace function public.get_project_workspace(p_project_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  project_record public.student_projects%rowtype;
  viewer_profile public.profiles%rowtype;
  members_json jsonb;
  tasks_json jsonb;
  messages_json jsonb;
begin
  if not public.can_access_project(p_project_id) then
    raise exception 'You do not have access to this project';
  end if;

  select * into project_record from public.student_projects where id = p_project_id;
  select * into viewer_profile from public.profiles where id = auth.uid();

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', person.id,
      'name', trim(concat_ws(' ', person.first_name, person.last_name)),
      'team_role', person.team_role
    ) order by person.member_order, person.first_name, person.last_name
  ), '[]'::jsonb) into members_json
  from (
    select p.id, p.first_name, p.last_name, 'leader'::text as team_role, 0 as member_order
    from public.profiles p where p.id = project_record.student_id
    union all
    select p.id, p.first_name, p.last_name, 'member'::text as team_role, 1 as member_order
    from public.project_member pm
    join public.profiles p on p.id = pm.student_id
    where pm.project_id = p_project_id
  ) person;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', task.id,
      'title', task.title,
      'instructions', task.instructions,
      'sort_order', task.sort_order,
      'created_at', task.created_at,
      'submissions', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', submission.id,
            'version', submission.version,
            'message', submission.message,
            'file_path', submission.file_path,
            'file_name', submission.file_name,
            'mime_type', submission.mime_type,
            'file_size', submission.file_size,
            'status', submission.status,
            'teacher_feedback', submission.teacher_feedback,
            'submitted_by', trim(concat_ws(' ', submitter.first_name, submitter.last_name)),
            'reviewed_by', trim(concat_ws(' ', reviewer.first_name, reviewer.last_name)),
            'reviewed_at', submission.reviewed_at,
            'created_at', submission.created_at
          ) order by submission.version desc
        )
        from public.project_submissions submission
        join public.profiles submitter on submitter.id = submission.submitted_by
        left join public.profiles reviewer on reviewer.id = submission.reviewed_by
        where submission.task_id = task.id
      ), '[]'::jsonb)
    ) order by task.sort_order
  ), '[]'::jsonb) into tasks_json
  from public.project_tasks task
  where task.project_id = p_project_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', message.id,
      'body', message.body,
      'sender_id', message.sender_id,
      'sender_name', trim(concat_ws(' ', sender.first_name, sender.last_name)),
      'sender_role', sender.role,
      'created_at', message.created_at
    ) order by message.created_at
  ), '[]'::jsonb) into messages_json
  from public.project_messages message
  join public.profiles sender on sender.id = message.sender_id
  where message.project_id = p_project_id;

  return jsonb_build_object(
    'project', jsonb_build_object(
      'id', project_record.id,
      'title', project_record.title,
      'description', project_record.description,
      'category', project_record.category,
      'advisor', project_record.advisor,
      'student_name', project_record.student_name,
      'status', project_record.status,
      'progress', project_record.progress,
      'created_at', project_record.created_at
    ),
    'viewer', jsonb_build_object(
      'id', viewer_profile.id,
      'name', trim(concat_ws(' ', viewer_profile.first_name, viewer_profile.last_name)),
      'role', viewer_profile.role,
      'is_advisor', public.is_project_advisor(p_project_id),
      'is_student', public.is_project_student(p_project_id)
    ),
    'members', members_json,
    'tasks', tasks_json,
    'messages', messages_json
  );
end;
$$;

revoke all on function public.add_project_task(bigint, text, text) from public;
revoke all on function public.update_project_task(uuid, text, text) from public;
revoke all on function public.delete_project_task(uuid) from public;
revoke all on function public.submit_project_task(uuid, text, text, text, text, bigint) from public;
revoke all on function public.review_project_submission(uuid, text, text) from public;
revoke all on function public.send_project_message(bigint, text) from public;
revoke all on function public.get_project_workspace(bigint) from public;

grant execute on function public.add_project_task(bigint, text, text) to authenticated;
grant execute on function public.update_project_task(uuid, text, text) to authenticated;
grant execute on function public.delete_project_task(uuid) to authenticated;
grant execute on function public.submit_project_task(uuid, text, text, text, text, bigint) to authenticated;
grant execute on function public.review_project_submission(uuid, text, text) to authenticated;
grant execute on function public.send_project_message(bigint, text) to authenticated;
grant execute on function public.get_project_workspace(bigint) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'project-submissions',
  'project-submissions',
  false,
  20971520,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg',
    'image/png',
    'application/zip',
    'text/plain'
  ]::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "project_students_upload_submission_files" on storage.objects;
create policy "project_students_upload_submission_files" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'project-submissions'
  and (storage.foldername(name))[1] ~ '^[0-9]+$'
  and (storage.foldername(name))[2] = auth.uid()::text
  and public.is_project_student(((storage.foldername(name))[1])::bigint)
);

drop policy if exists "project_participants_read_submission_files" on storage.objects;
create policy "project_participants_read_submission_files" on storage.objects
for select to authenticated
using (
  bucket_id = 'project-submissions'
  and (storage.foldername(name))[1] ~ '^[0-9]+$'
  and public.can_access_project(((storage.foldername(name))[1])::bigint)
);

drop policy if exists "project_participants_delete_submission_files" on storage.objects;
create policy "project_participants_delete_submission_files" on storage.objects
for delete to authenticated
using (
  bucket_id = 'project-submissions'
  and (storage.foldername(name))[1] ~ '^[0-9]+$'
  and (
    owner_id = auth.uid()::text
    or public.is_project_advisor(((storage.foldername(name))[1])::bigint)
  )
);

notify pgrst, 'reload schema';
