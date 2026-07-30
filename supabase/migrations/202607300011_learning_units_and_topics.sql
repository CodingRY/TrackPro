-- Organize lessons by learning unit and topic while preserving existing lessons.

alter table public.learning_lessons
  add column if not exists unit_title text not null default 'หน่วยการเรียนรู้ทั่วไป',
  add column if not exists unit_order integer not null default 0,
  add column if not exists topic_title text not null default 'หัวข้อทั่วไป',
  add column if not exists topic_order integer not null default 0;

update public.learning_lessons
set
  unit_title = coalesce(nullif(trim(unit_title), ''), 'หน่วยการเรียนรู้ทั่วไป'),
  topic_title = coalesce(nullif(trim(topic_title), ''), 'หัวข้อทั่วไป'),
  unit_order = greatest(0, coalesce(unit_order, 0)),
  topic_order = greatest(0, coalesce(topic_order, 0));

alter table public.learning_lessons
  drop constraint if exists learning_lessons_unit_title_length,
  add constraint learning_lessons_unit_title_length
    check (char_length(trim(unit_title)) between 1 and 120),
  drop constraint if exists learning_lessons_topic_title_length,
  add constraint learning_lessons_topic_title_length
    check (char_length(trim(topic_title)) between 1 and 120),
  drop constraint if exists learning_lessons_unit_order_range,
  add constraint learning_lessons_unit_order_range
    check (unit_order between 0 and 9999),
  drop constraint if exists learning_lessons_topic_order_range,
  add constraint learning_lessons_topic_order_range
    check (topic_order between 0 and 9999);

drop index if exists public.learning_lessons_order_idx;
create index learning_lessons_order_idx
  on public.learning_lessons (
    is_published,
    unit_order,
    unit_title,
    topic_order,
    topic_title,
    sort_order,
    created_at
  );

comment on column public.learning_lessons.unit_title is
  'Learning unit used to group lessons in the course outline.';
comment on column public.learning_lessons.topic_title is
  'Topic within a learning unit.';
