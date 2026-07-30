-- Only the assigned teacher may approve or reject a student project.

create or replace function public.protect_project_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  reviewer_role text;
  reviewer_name text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- Trusted server operations and SQL Editor maintenance are allowed.
  if auth.uid() is null or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  select role, trim(concat_ws(' ', first_name, last_name))
    into reviewer_role, reviewer_name
  from public.profiles
  where id = auth.uid();

  if reviewer_role is distinct from 'teacher' then
    raise exception 'Only teachers can review projects';
  end if;

  if reviewer_name is distinct from old.advisor then
    raise exception 'Only the assigned advisor can review this project';
  end if;

  if new.status is null or new.status not in ('pending', 'approved', 'rejected') then
    raise exception 'Invalid project status';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_project_review_trigger on public.student_projects;
create trigger protect_project_review_trigger
before update of status on public.student_projects
for each row execute function public.protect_project_review();

comment on function public.protect_project_review() is
  'Prevents admins and unassigned users from approving or rejecting student projects.';
