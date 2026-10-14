-- Migration: 202610150004_shop_name_as_account.sql
-- Description: Automatically assign shop_name as the account display name when new accounts are created.

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_shop text;
  v_name text;
begin
  v_shop := coalesce(nullif(trim(new.raw_user_meta_data->>'shop_name'), ''), 'ร้านค้า');
  -- When user enters shop name, bind shop name as account display name unless explicitly specified
  v_name := coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), v_shop);

  insert into public.profiles(id, display_name, shop_name)
  values(new.id, v_name, v_shop)
  on conflict(id) do update set
    shop_name = excluded.shop_name,
    display_name = case
      when public.profiles.display_name in ('เจ้าของร้าน', 'kaikai', '') then excluded.display_name
      else public.profiles.display_name
    end;

  return new;
end;
$$;
