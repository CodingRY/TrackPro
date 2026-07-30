-- Reusable unit/topic catalog managed by administrators before lessons are created.

create table if not exists public.learning_units (
  id uuid primary key default gen_random_uuid(),
  title text not null unique check (char_length(trim(title)) between 1 and 120),
  sort_order integer not null default 0 check (sort_order between 0 and 9999),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.learning_topics (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.learning_units(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 120),
  sort_order integer not null default 0 check (sort_order between 0 and 9999),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unit_id, title)
);

create index if not exists learning_units_sort_idx
  on public.learning_units (sort_order, title, created_at);
create index if not exists learning_topics_sort_idx
  on public.learning_topics (unit_id, sort_order, title, created_at);

-- Preserve every unit and topic already used by existing lessons.
insert into public.learning_units (title, sort_order)
select unit_title, min(unit_order)
from public.learning_lessons
group by unit_title
on conflict (title) do update
set sort_order = least(public.learning_units.sort_order, excluded.sort_order);

insert into public.learning_topics (unit_id, title, sort_order)
select unit.id, lesson.topic_title, min(lesson.topic_order)
from public.learning_lessons lesson
join public.learning_units unit on unit.title = lesson.unit_title
group by unit.id, lesson.topic_title
on conflict (unit_id, title) do update
set sort_order = least(public.learning_topics.sort_order, excluded.sort_order);

alter table public.learning_units enable row level security;
alter table public.learning_topics enable row level security;

drop policy if exists "authenticated_read_learning_units" on public.learning_units;
create policy "authenticated_read_learning_units" on public.learning_units
for select to authenticated using (true);

drop policy if exists "admins_create_learning_units" on public.learning_units;
create policy "admins_create_learning_units" on public.learning_units
for insert to authenticated with check (public.is_admin() and created_by = auth.uid());

drop policy if exists "admins_update_learning_units" on public.learning_units;
create policy "admins_update_learning_units" on public.learning_units
for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins_delete_learning_units" on public.learning_units;
create policy "admins_delete_learning_units" on public.learning_units
for delete to authenticated using (public.is_admin());

drop policy if exists "authenticated_read_learning_topics" on public.learning_topics;
create policy "authenticated_read_learning_topics" on public.learning_topics
for select to authenticated using (true);

drop policy if exists "admins_create_learning_topics" on public.learning_topics;
create policy "admins_create_learning_topics" on public.learning_topics
for insert to authenticated with check (public.is_admin() and created_by = auth.uid());

drop policy if exists "admins_update_learning_topics" on public.learning_topics;
create policy "admins_update_learning_topics" on public.learning_topics
for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins_delete_learning_topics" on public.learning_topics;
create policy "admins_delete_learning_topics" on public.learning_topics
for delete to authenticated using (public.is_admin());

grant select, insert, update, delete on public.learning_units to authenticated;
grant select, insert, update, delete on public.learning_topics to authenticated;

comment on table public.learning_units is
  'Reusable learning units created by administrators.';
comment on table public.learning_topics is
  'Reusable lesson topics belonging to a learning unit.';
