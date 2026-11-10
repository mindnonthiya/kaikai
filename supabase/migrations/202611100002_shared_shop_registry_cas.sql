-- Serialize shops_registry updates so concurrent tabs/devices cannot silently
-- overwrite each other's shop creation, linking or deletion changes.
create or replace function public.compare_and_set_shops_registry(
  p_expected_shops jsonb,
  p_next_shops jsonb,
  p_updated_at timestamptz default now()
) returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_owner uuid := auth.uid();
  v_current jsonb;
begin
  if v_owner is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_owner::text));

  select coalesce(value -> 'shops', '[]'::jsonb)
    into v_current
  from public.settings
  where owner_id = v_owner and key = 'shops_registry'
  for update;

  v_current := coalesce(v_current, '[]'::jsonb);
  if v_current is distinct from coalesce(p_expected_shops, '[]'::jsonb) then
    return false;
  end if;

  insert into public.settings(owner_id, key, value, updated_at)
  values (
    v_owner,
    'shops_registry',
    jsonb_build_object('shops', coalesce(p_next_shops, '[]'::jsonb)),
    coalesce(p_updated_at, now())
  )
  on conflict (owner_id, key) do update
  set value = excluded.value,
      updated_at = excluded.updated_at;

  return true;
end;
$$;

revoke all on function public.compare_and_set_shops_registry(jsonb, jsonb, timestamptz) from public;
grant execute on function public.compare_and_set_shops_registry(jsonb, jsonb, timestamptz) to authenticated;

-- Enforce that a sale can only contain menus from the same shop encoded in the
-- sale notes. This protects the client-side create_sale RPC from crafted menu IDs.
create or replace function public.enforce_sale_item_shop_scope()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_sale_owner uuid;
  v_sale_notes text;
  v_menu_owner uuid;
  v_menu_name text;
  v_sale_shop text;
  v_menu_shop text;
begin
  select owner_id, notes into v_sale_owner, v_sale_notes
  from public.sales where id = new.sale_id;
  select owner_id, name into v_menu_owner, v_menu_name
  from public.menus where id = new.menu_id;

  if v_sale_owner is null or v_menu_owner is null or new.owner_id <> v_sale_owner or new.owner_id <> v_menu_owner then
    raise exception 'sale item owner mismatch' using errcode = '23514';
  end if;

  v_sale_shop := coalesce(substring(coalesce(v_sale_notes, '') from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default');
  v_menu_shop := coalesce(substring(coalesce(v_menu_name, '') from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default');
  if v_sale_shop <> v_menu_shop then
    raise exception 'sale and menu belong to different shops' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists sale_items_shop_scope on public.sale_items;
create trigger sale_items_shop_scope
before insert or update of sale_id, menu_id, owner_id on public.sale_items
for each row execute function public.enforce_sale_item_shop_scope();

notify pgrst, 'reload schema';
