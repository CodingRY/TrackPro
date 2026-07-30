-- Advisor-managed proposal and optional competition deadlines per project.

alter table public.student_projects
  add column if not exists proposal_due_date date,
  add column if not exists competition_name text not null default '',
  add column if not exists competition_due_date date;

alter table public.student_projects
  drop constraint if exists student_projects_competition_name_length_check;
alter table public.student_projects
  add constraint student_projects_competition_name_length_check
  check (char_length(trim(competition_name)) <= 160);

alter table public.student_projects
  drop constraint if exists student_projects_competition_deadline_pair_check;
alter table public.student_projects
  add constraint student_projects_competition_deadline_pair_check
  check (
    (competition_due_date is null and trim(competition_name) = '')
    or (competition_due_date is not null and char_length(trim(competition_name)) > 0)
  );

create or replace function public.update_project_deadlines(
  p_project_id bigint,
  p_proposal_due_date date,
  p_competition_name text default '',
  p_competition_due_date date default null
)
returns public.student_projects
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.student_projects%rowtype;
begin
  if not public.is_project_advisor(p_project_id) then
    raise exception 'Only the assigned advisor can update project deadlines';
  end if;
  if p_proposal_due_date is null then
    raise exception 'Proposal deadline is required';
  end if;
  if char_length(trim(coalesce(p_competition_name, ''))) > 160 then
    raise exception 'Competition name is too long';
  end if;
  if (p_competition_due_date is null) <> (nullif(trim(coalesce(p_competition_name, '')), '') is null) then
    raise exception 'Competition name and deadline must be provided together';
  end if;
  if p_competition_due_date is not null and p_competition_due_date < p_proposal_due_date then
    raise exception 'Competition deadline must be on or after proposal deadline';
  end if;

  update public.student_projects
  set proposal_due_date = p_proposal_due_date,
      competition_name = case when p_competition_due_date is null then '' else trim(p_competition_name) end,
      competition_due_date = p_competition_due_date
  where id = p_project_id
  returning * into result;

  if result.id is null then
    raise exception 'Project not found';
  end if;
  return result;
end;
$$;

revoke all on function public.update_project_deadlines(bigint, date, text, date) from public;
grant execute on function public.update_project_deadlines(bigint, date, text, date) to authenticated;

notify pgrst, 'reload schema';
