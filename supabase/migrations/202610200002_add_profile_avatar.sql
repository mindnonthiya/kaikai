-- Migration: 202610200002_add_profile_avatar.sql
-- Description: Add avatar_url to public.profiles and persist user avatar from OAuth or user metadata.

alter table public.profiles add column if not exists avatar_url text;

-- Update handle_new_user function to automatically capture avatar_url from metadata on signup
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_shop text;
  v_name text;
  v_avatar text;
begin
  v_shop := coalesce(nullif(trim(new.raw_user_meta_data->>'shop_name'), ''), 'ร้านค้า');
  v_name := coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), v_shop);
  v_avatar := coalesce(nullif(trim(new.raw_user_meta_data->>'avatar_url'), ''), nullif(trim(new.raw_user_meta_data->>'picture'), ''));

  insert into public.profiles(id, display_name, shop_name, avatar_url)
  values(new.id, v_name, v_shop, v_avatar)
  on conflict(id) do update set
    shop_name = excluded.shop_name,
    display_name = case
      when public.profiles.display_name in ('เจ้าของร้าน', 'kaikai', '') then excluded.display_name
      else public.profiles.display_name
    end,
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url);

  return new;
end;
$$;
