-- v2 costing (run after 202610140001_packaging_delivery.sql). Safe to run more than once.
--   * Main ingredients (chicken) are counted per piece in recipes: bought by กก., 1 กก. ≈ N pieces.
--     N can be learned automatically from real sales between purchases.
--   * Other ingredients (rice, herbs, sauce…) are "pooled": their purchases ÷ food sales = a % added to each order.
--   * Packaging purchases remember how many packs were bought.
--   * Labor/overhead/typed-in food cost per dish are no longer used (gas/electricity are entered later as expenses).

-- 1) Ingredients
alter table public.ingredients add column if not exists costing text not null default 'per_unit';
alter table public.ingredients drop constraint if exists ingredients_costing_check;
alter table public.ingredients add constraint ingredients_costing_check check (costing in ('per_unit','pooled'));
-- unit the owner buys in (e.g. กก.) and how many recipe units (e.g. pieces) one of it gives
alter table public.ingredients add column if not exists purchase_unit text;
alter table public.ingredients add column if not exists units_per_purchase_unit numeric(12,4) not null default 1 check (units_per_purchase_unit > 0);
alter table public.ingredients add column if not exists yield_auto boolean not null default false;
alter table public.ingredients add column if not exists yield_updated_at timestamptz;
-- weighted price per purchase unit over the last 30 days (e.g. 122.50 ฿ per กก. in satang)
alter table public.ingredients add column if not exists price_per_purchase_unit_satang numeric(18,6) not null default 0 check (price_per_purchase_unit_satang >= 0);
update public.ingredients set purchase_unit = base_unit where purchase_unit is null;
update public.ingredients set price_per_purchase_unit_satang = weighted_unit_cost_satang
  where price_per_purchase_unit_satang = 0 and units_per_purchase_unit = 1;

-- 2) Ingredient purchases: pooled items are recorded by amount only, so quantity is optional.
alter table public.ingredient_purchases alter column purchased_quantity drop not null;
alter table public.ingredient_purchases alter column usable_quantity drop not null;
alter table public.ingredient_purchases alter column purchase_unit drop not null;
create index if not exists ingredient_purchases_item_date_idx on public.ingredient_purchases(ingredient_id, purchased_at desc);
create index if not exists ingredient_purchases_owner_date_idx on public.ingredient_purchases(owner_id, purchased_at desc);

-- 3) Packaging purchases: number of packs bought (price_satang / pack_quantity stay the totals).
alter table public.packaging_purchases add column if not exists pack_count integer not null default 1 check (pack_count > 0);

-- 4) Menus: drop per-dish labor/overhead/typed food cost and recompute cost = per-piece ingredients + per-order packaging.
update public.menus set labor_cost_satang = 0, overhead_cost_satang = 0, manual_food_cost_satang = 0
  where labor_cost_satang <> 0 or overhead_cost_satang <> 0 or manual_food_cost_satang <> 0;
update public.menus m set
  packaging_cost_satang = coalesce((
    select round(sum(r.quantity * p.unit_cost_satang)) from public.menu_recipe_items r
    join public.packaging_items p on p.id = r.packaging_item_id where r.menu_id = m.id and p.per_order), 0),
  current_cost_satang = coalesce((
    select round(sum(r.quantity * i.weighted_unit_cost_satang)) from public.menu_recipe_items r
    join public.ingredients i on i.id = r.ingredient_id where r.menu_id = m.id and i.costing = 'per_unit'), 0)
    + coalesce((
    select round(sum(r.quantity * p.unit_cost_satang)) from public.menu_recipe_items r
    join public.packaging_items p on p.id = r.packaging_item_id where r.menu_id = m.id and p.per_order), 0),
  cost_calculated_at = now();

-- 5) create_sale v3
--    payload.pooled_ingredient_bps = other-ingredient cost as basis points of the selling price (1000 = 10%),
--    calculated by the app from the last 30 days. Each dish's cost = menu cost + price × bps.
create or replace function public.create_sale(payload jsonb) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_sale_id uuid; v_item jsonb; v_menu public.menus%rowtype; v_pack public.packaging_items%rowtype;
  v_product bigint := 0; v_food bigint := 0; v_default_pack bigint := 0; v_pack_cost bigint := 0; v_cogs bigint; v_pool bigint;
  v_discount bigint := coalesce((payload->>'discount_satang')::bigint,0);
  v_delivery bigint := coalesce((payload->>'delivery_charged_satang')::bigint,0);
  v_fee bigint := coalesce((payload->>'payment_fee_satang')::bigint,0);
  v_payment bigint := coalesce((payload->>'payment_amount_satang')::bigint,0);
  v_bps integer := coalesce((payload->>'pooled_ingredient_bps')::integer,0);
  v_fulfillment text := coalesce(payload->>'fulfillment','pickup');
  v_has_packaging boolean := coalesce(jsonb_typeof(payload->'packaging') = 'array', false);
  v_net bigint; v_quantity integer;
begin
  if v_owner is null then raise exception 'authentication required'; end if;
  if jsonb_typeof(payload->'items') <> 'array' or jsonb_array_length(payload->'items') = 0 then raise exception 'at least one item is required'; end if;
  if v_discount < 0 or v_delivery < 0 or v_fee < 0 or v_payment < 0 then raise exception 'negative money is not allowed'; end if;
  if v_bps < 0 or v_bps > 10000 then raise exception 'invalid pooled ingredient rate'; end if;
  if v_fulfillment not in ('pickup','delivery') then raise exception 'invalid fulfillment'; end if;

  for v_item in select * from jsonb_array_elements(payload->'items') loop
    v_quantity := (v_item->>'quantity')::integer; if v_quantity <= 0 then raise exception 'quantity must be positive'; end if;
    select * into v_menu from public.menus where id=(v_item->>'menu_id')::uuid and owner_id=v_owner and is_available=true for share;
    if not found then raise exception 'menu unavailable'; end if;
    v_pool := round(v_menu.selling_price_satang * v_bps / 10000.0)::bigint;
    v_product := v_product + v_menu.selling_price_satang*v_quantity;
    v_food := v_food + (greatest(0, v_menu.current_cost_satang - v_menu.packaging_cost_satang) + v_pool)*v_quantity;
    v_default_pack := v_default_pack + v_menu.packaging_cost_satang*v_quantity;
  end loop;

  if v_has_packaging then
    for v_item in select * from jsonb_array_elements(payload->'packaging') loop
      v_quantity := (v_item->>'quantity')::integer;
      if v_quantity < 0 then raise exception 'quantity must be positive'; end if;
      continue when v_quantity = 0;
      select * into v_pack from public.packaging_items where id=(v_item->>'packaging_item_id')::uuid and owner_id=v_owner;
      if not found then raise exception 'packaging not found'; end if;
      v_pack_cost := v_pack_cost + round(v_pack.unit_cost_satang * v_quantity)::bigint;
    end loop;
  else
    v_pack_cost := v_default_pack;
  end if;

  v_cogs := v_food + v_pack_cost;
  v_net := v_product-v_discount+v_delivery-v_fee; if v_net < 0 then raise exception 'net revenue cannot be negative'; end if;
  insert into public.sales(owner_id,sold_at,status,payment_status,customer_name,notes,fulfillment,product_revenue_satang,discount_satang,delivery_charged_satang,payment_fee_satang,packaging_cost_satang,net_revenue_satang,cogs_satang,gross_profit_satang)
    values(v_owner,coalesce((payload->>'sold_at')::timestamptz,now()),'confirmed',coalesce((payload->>'payment_status')::public.payment_status,'paid'),payload->>'customer_name',payload->>'notes',v_fulfillment,v_product,v_discount,v_delivery,v_fee,v_pack_cost,v_net,v_cogs,v_net-v_cogs)
    returning id into v_sale_id;

  for v_item in select * from jsonb_array_elements(payload->'items') loop
    v_quantity := (v_item->>'quantity')::integer; select * into v_menu from public.menus where id=(v_item->>'menu_id')::uuid and owner_id=v_owner;
    v_pool := round(v_menu.selling_price_satang * v_bps / 10000.0)::bigint;
    insert into public.menu_cost_snapshots(owner_id,menu_id,ingredient_cost_satang,packaging_cost_satang,labor_cost_satang,overhead_cost_satang,total_cost_satang)
      values(v_owner,v_menu.id,greatest(0,v_menu.current_cost_satang-v_menu.packaging_cost_satang)+v_pool,v_menu.packaging_cost_satang,0,0,v_menu.current_cost_satang+v_pool);
    insert into public.sale_items(owner_id,sale_id,menu_id,menu_name_snapshot,menu_category_snapshot,quantity,unit_price_satang,ingredient_cost_satang,packaging_cost_satang,labor_cost_satang,overhead_cost_satang,unit_cost_satang,unit_profit_satang,line_revenue_satang,line_cost_satang)
      values(v_owner,v_sale_id,v_menu.id,v_menu.name,v_menu.category,v_quantity,v_menu.selling_price_satang,greatest(0,v_menu.current_cost_satang-v_menu.packaging_cost_satang)+v_pool,v_menu.packaging_cost_satang,0,0,v_menu.current_cost_satang+v_pool,v_menu.selling_price_satang-v_menu.current_cost_satang-v_pool,v_menu.selling_price_satang*v_quantity,(v_menu.current_cost_satang+v_pool)*v_quantity);
  end loop;

  if v_has_packaging then
    for v_item in select * from jsonb_array_elements(payload->'packaging') loop
      v_quantity := (v_item->>'quantity')::integer;
      continue when v_quantity = 0;
      select * into v_pack from public.packaging_items where id=(v_item->>'packaging_item_id')::uuid and owner_id=v_owner;
      insert into public.sale_packaging(owner_id,sale_id,packaging_item_id,name_snapshot,quantity,unit_cost_satang,line_cost_satang)
        values(v_owner,v_sale_id,v_pack.id,v_pack.name,v_quantity,v_pack.unit_cost_satang,round(v_pack.unit_cost_satang * v_quantity)::bigint);
    end loop;
  end if;

  if v_payment > 0 then insert into public.payments(owner_id,sale_id,method,amount_satang,paid_at,reference_number) values(v_owner,v_sale_id,coalesce((payload->>'payment_method')::public.payment_method,'cash'),v_payment,now(),payload->>'reference_number'); end if;
  if payload ? 'slip' then insert into public.slip_uploads(owner_id,sale_id,storage_path,mime_type,size_bytes,file_hash_sha256,ocr_status) values(v_owner,v_sale_id,payload#>>'{slip,storage_path}',payload#>>'{slip,mime_type}',(payload#>>'{slip,size_bytes}')::bigint,payload#>>'{slip,file_hash_sha256}','pending'); end if;
  insert into public.audit_logs(owner_id,entity_type,entity_id,action,new_data) values(v_owner,'sale',v_sale_id,'created',jsonb_build_object('net_revenue_satang',v_net,'cogs_satang',v_cogs,'packaging_cost_satang',v_pack_cost,'pooled_ingredient_bps',v_bps));
  return jsonb_build_object('sale_id',v_sale_id,'product_revenue_satang',v_product,'net_revenue_satang',v_net,'cogs_satang',v_cogs,'packaging_cost_satang',v_pack_cost,'gross_profit_satang',v_net-v_cogs);
end $$;
revoke all on function public.create_sale(jsonb) from public,anon;
grant execute on function public.create_sale(jsonb) to authenticated;
