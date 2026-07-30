-- Allow authenticated TrackPro admins to remove images attached to community posts.

drop policy if exists "admin_delete_community_images" on storage.objects;
create policy "admin_delete_community_images" on storage.objects
for delete to authenticated
using (bucket_id = 'pics' and public.is_admin());
