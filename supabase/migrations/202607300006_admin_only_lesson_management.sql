-- Only administrators may create, edit, or delete learning lessons.

drop policy if exists "teachers_create_learning_lessons" on public.learning_lessons;
drop policy if exists "lesson_owners_update_learning_lessons" on public.learning_lessons;
drop policy if exists "lesson_owners_delete_learning_lessons" on public.learning_lessons;

drop policy if exists "admins_create_learning_lessons" on public.learning_lessons;
create policy "admins_create_learning_lessons" on public.learning_lessons
for insert to authenticated
with check (public.is_admin() and created_by = auth.uid());

drop policy if exists "admins_update_learning_lessons" on public.learning_lessons;
create policy "admins_update_learning_lessons" on public.learning_lessons
for update to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "admins_delete_learning_lessons" on public.learning_lessons;
create policy "admins_delete_learning_lessons" on public.learning_lessons
for delete to authenticated
using (public.is_admin());

notify pgrst, 'reload schema';
