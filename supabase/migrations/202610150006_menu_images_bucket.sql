-- Menu Images storage bucket and access policies
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Allow public read access so menu pictures load fast in dashboard/POS
create policy "menu_images_public_read" on storage.objects
  for select using (bucket_id = 'menu-images');

-- Allow authenticated users to upload and manage their own menu images in user folder
create policy "menu_images_user_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'menu-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "menu_images_user_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'menu-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "menu_images_user_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'menu-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
