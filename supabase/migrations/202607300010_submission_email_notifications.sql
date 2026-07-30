-- Idempotent email delivery state for student task submissions.

create table if not exists public.submission_email_notifications (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.project_submissions(id) on delete cascade,
  recipient_user_id uuid references public.profiles(id) on delete set null,
  recipient_email text not null default '',
  status text not null default 'processing' check (status in ('processing', 'sent', 'failed')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  provider_message_id text,
  error_message text not null default '',
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(recipient_email) <= 320),
  check (char_length(error_message) <= 2000)
);

create index if not exists submission_email_notifications_status_idx
  on public.submission_email_notifications (status, updated_at desc);

alter table public.submission_email_notifications enable row level security;
revoke all on table public.submission_email_notifications from anon, authenticated;
grant select, insert, update, delete on table public.submission_email_notifications to service_role;

create or replace function public.claim_submission_email_notification(
  p_submission_id uuid,
  p_recipient_user_id uuid,
  p_recipient_email text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role is required';
  end if;
  if nullif(trim(p_recipient_email), '') is null then
    raise exception 'Recipient email is required';
  end if;

  insert into public.submission_email_notifications (
    submission_id,
    recipient_user_id,
    recipient_email,
    status,
    attempt_count,
    claimed_at,
    updated_at
  ) values (
    p_submission_id,
    p_recipient_user_id,
    lower(trim(p_recipient_email)),
    'processing',
    1,
    now(),
    now()
  )
  on conflict (submission_id) do update
  set recipient_user_id = excluded.recipient_user_id,
      recipient_email = excluded.recipient_email,
      status = 'processing',
      attempt_count = public.submission_email_notifications.attempt_count + 1,
      provider_message_id = null,
      error_message = '',
      claimed_at = now(),
      updated_at = now()
  where public.submission_email_notifications.status = 'failed'
     or (
       public.submission_email_notifications.status = 'processing'
       and public.submission_email_notifications.claimed_at < now() - interval '10 minutes'
     )
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_submission_email_notification(uuid, uuid, text) from public;
grant execute on function public.claim_submission_email_notification(uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
