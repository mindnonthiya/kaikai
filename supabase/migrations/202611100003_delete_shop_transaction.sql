-- Delete one secondary shop as a single database transaction. The application
-- recalculates the returned shared catalog item IDs after this transaction.
create or replace function public.delete_shop_transaction(
  p_shop_id text,
  p_expected_shops jsonb,
  p_next_shops jsonb,
  p_new_catalog_owner text default null
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_owner uuid := auth.uid();
  v_prefix text;
  v_new_prefix text;
  v_current jsonb;
  v_expense_ids uuid[] := array[]::uuid[];
  v_menu_ids uuid[] := array[]::uuid[];
  v_ingredient_ids uuid[] := array[]::uuid[];
  v_packaging_ids uuid[] := array[]::uuid[];
  v_affected_ingredients uuid[] := array[]::uuid[];
  v_affected_packaging uuid[] := array[]::uuid[];
begin
  if v_owner is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_shop_id is null or p_shop_id = '' or p_shop_id = 'default'
     or p_shop_id !~ '^[a-zA-Z0-9_-]{2,36}$' then
    raise exception 'invalid shop id' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_owner::text));
  select coalesce(value -> 'shops', '[]'::jsonb)
    into v_current
  from public.settings
  where owner_id = v_owner and key = 'shops_registry'
  for update;
  v_current := coalesce(v_current, '[]'::jsonb);
  if v_current is distinct from coalesce(p_expected_shops, '[]'::jsonb) then
    raise exception 'shops registry changed concurrently' using errcode = '40001';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_current) entry
    where entry ->> 'id' = p_shop_id
  ) then
    raise exception 'shop not found' using errcode = 'P0002';
  end if;

  v_prefix := '[s:' || p_shop_id || ']';
  if p_new_catalog_owner is not null then
    if p_new_catalog_owner = 'default' then
      v_new_prefix := '';
    elsif p_new_catalog_owner ~ '^[a-zA-Z0-9_-]{2,36}$' then
      v_new_prefix := '[s:' || p_new_catalog_owner || ']';
    else
      raise exception 'invalid new catalog owner' using errcode = '23514';
    end if;
  end if;

  select coalesce(array_agg(id), array[]::uuid[])
    into v_expense_ids
  from public.expenses
  where owner_id = v_owner
    and left(coalesce(description, ''), length(v_prefix)) = v_prefix;

  select coalesce(array_agg(distinct ingredient_id), array[]::uuid[])
    into v_affected_ingredients
  from public.ingredient_purchases
  where owner_id = v_owner
    and (
      left(coalesce(vendor, ''), length(v_prefix)) = v_prefix
      or expense_id = any(v_expense_ids)
    );

  select coalesce(array_agg(distinct packaging_item_id), array[]::uuid[])
    into v_affected_packaging
  from public.packaging_purchases
  where owner_id = v_owner
    and (
      left(coalesce(vendor, ''), length(v_prefix)) = v_prefix
      or expense_id = any(v_expense_ids)
    );

  delete from public.ingredient_purchases
  where owner_id = v_owner
    and (
      left(coalesce(vendor, ''), length(v_prefix)) = v_prefix
      or expense_id = any(v_expense_ids)
    );
  delete from public.packaging_purchases
  where owner_id = v_owner
    and (
      left(coalesce(vendor, ''), length(v_prefix)) = v_prefix
      or expense_id = any(v_expense_ids)
    );
  delete from public.expenses where owner_id = v_owner and id = any(v_expense_ids);
  delete from public.sales
  where owner_id = v_owner and left(coalesce(notes, ''), length(v_prefix)) = v_prefix;

  select coalesce(array_agg(id), array[]::uuid[])
    into v_menu_ids
  from public.menus
  where owner_id = v_owner and left(name, length(v_prefix)) = v_prefix;
  delete from public.sale_items where owner_id = v_owner and menu_id = any(v_menu_ids);
  delete from public.menu_recipe_items where owner_id = v_owner and menu_id = any(v_menu_ids);
  delete from public.menus where owner_id = v_owner and id = any(v_menu_ids);

  select coalesce(array_agg(id), array[]::uuid[])
    into v_ingredient_ids
  from public.ingredients
  where owner_id = v_owner and left(name, length(v_prefix)) = v_prefix;
  if p_new_catalog_owner is not null then
    update public.ingredients
    set name = v_new_prefix || substr(name, length(v_prefix) + 1), updated_at = now()
    where owner_id = v_owner and id = any(v_ingredient_ids);
  else
    delete from public.menu_recipe_items where owner_id = v_owner and ingredient_id = any(v_ingredient_ids);
    delete from public.ingredient_purchases where owner_id = v_owner and ingredient_id = any(v_ingredient_ids);
    delete from public.ingredients where owner_id = v_owner and id = any(v_ingredient_ids);
    v_affected_ingredients := array(
      select id from unnest(v_affected_ingredients) id where not (id = any(v_ingredient_ids))
    );
  end if;

  select coalesce(array_agg(id), array[]::uuid[])
    into v_packaging_ids
  from public.packaging_items
  where owner_id = v_owner and left(name, length(v_prefix)) = v_prefix;
  if p_new_catalog_owner is not null then
    update public.packaging_items
    set name = v_new_prefix || substr(name, length(v_prefix) + 1), updated_at = now()
    where owner_id = v_owner and id = any(v_packaging_ids);
  else
    delete from public.sale_packaging where owner_id = v_owner and packaging_item_id = any(v_packaging_ids);
    delete from public.menu_recipe_items where owner_id = v_owner and packaging_item_id = any(v_packaging_ids);
    delete from public.packaging_purchases where owner_id = v_owner and packaging_item_id = any(v_packaging_ids);
    delete from public.packaging_items where owner_id = v_owner and id = any(v_packaging_ids);
    v_affected_packaging := array(
      select id from unnest(v_affected_packaging) id where not (id = any(v_packaging_ids))
    );
  end if;

  delete from public.settings
  where owner_id = v_owner
    and key = any(array[
      's:' || p_shop_id || ':profile',
      's:' || p_shop_id || ':sales',
      's:' || p_shop_id || ':price_presets'
    ]);

  insert into public.settings(owner_id, key, value, updated_at)
  values (v_owner, 'shops_registry', jsonb_build_object('shops', coalesce(p_next_shops, '[]'::jsonb)), now())
  on conflict (owner_id, key) do update
  set value = excluded.value, updated_at = excluded.updated_at;

  return jsonb_build_object(
    'affectedIngredientIds', to_jsonb(v_affected_ingredients),
    'affectedPackagingIds', to_jsonb(v_affected_packaging),
    'deletedExpenseIds', to_jsonb(v_expense_ids),
    'deletedMenuIds', to_jsonb(v_menu_ids)
  );
end;
$$;

revoke all on function public.delete_shop_transaction(text, jsonb, jsonb, text) from public;
grant execute on function public.delete_shop_transaction(text, jsonb, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
