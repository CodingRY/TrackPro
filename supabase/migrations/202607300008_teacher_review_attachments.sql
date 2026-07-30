-- Allow the assigned advisor to return an annotated file with each review.

alter table public.project_submissions
  add column if not exists teacher_file_path text,
  add column if not exists teacher_file_name text,
  add column if not exists teacher_mime_type text,
  add column if not exists teacher_file_size bigint;

alter table public.project_submissions
  drop constraint if exists project_submissions_teacher_file_size_check;
alter table public.project_submissions
  add constraint project_submissions_teacher_file_size_check
  check (teacher_file_size is null or (teacher_file_size >= 0 and teacher_file_size <= 20971520));

drop function if exists public.review_project_submission(uuid, text, text);

create or replace function public.review_project_submission(
  p_submission_id uuid,
  p_decision text,
  p_feedback text default '',
  p_teacher_file_path text default null,
  p_teacher_file_name text default null,
  p_teacher_mime_type text default null,
  p_teacher_file_size bigint default null
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
  if p_teacher_file_size is not null
     and (p_teacher_file_size < 0 or p_teacher_file_size > 20971520) then
    raise exception 'File is larger than 20 MB';
  end if;
  if p_teacher_file_path is not null and p_teacher_file_path not like
    submission_record.project_id::text || '/' || auth.uid()::text || '/teacher-feedback/%' then
    raise exception 'Invalid teacher feedback file path';
  end if;

  update public.project_submissions
  set status = p_decision,
      teacher_feedback = coalesce(trim(p_feedback), ''),
      teacher_file_path = p_teacher_file_path,
      teacher_file_name = case when p_teacher_file_path is null then null else p_teacher_file_name end,
      teacher_mime_type = case when p_teacher_file_path is null then null else p_teacher_mime_type end,
      teacher_file_size = case when p_teacher_file_path is null then null else p_teacher_file_size end,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  where id = p_submission_id
  returning * into result;

  perform public.recalculate_project_task_progress(submission_record.project_id);
  return result;
end;
$$;

revoke all on function public.review_project_submission(uuid, text, text, text, text, text, bigint) from public;
grant execute on function public.review_project_submission(uuid, text, text, text, text, text, bigint) to authenticated;

drop policy if exists "project_advisors_upload_review_files" on storage.objects;
create policy "project_advisors_upload_review_files" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'project-submissions'
  and (storage.foldername(name))[1] ~ '^[0-9]+$'
  and (storage.foldername(name))[2] = auth.uid()::text
  and (storage.foldername(name))[3] = 'teacher-feedback'
  and public.is_project_advisor(((storage.foldername(name))[1])::bigint)
);

notify pgrst, 'reload schema';
