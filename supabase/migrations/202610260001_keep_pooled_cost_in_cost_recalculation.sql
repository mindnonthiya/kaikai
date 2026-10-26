-- Migration 202610260001: keep the pooled-ingredient cost when historical sale costs are recalculated.
--
-- Bug: create_sale adds "other ingredients" (rice, herbs, sauce… = selling price × pooled %) to each item's cost,
-- but recalculate_historical_sales_costs / syncHistoricalCosts rewrote every item to menus.current_cost_satang,
-- which does not include that %. Every recalculation silently removed it and profit looked too high.
-- It also replaced the packaging actually handed out (sale_packaging) with the menu's default packaging,
-- and computed sale totals inside the same statement as the item update, so they could read stale item costs.
--
-- Fix:
--   1) sale_items.pooled_cost_satang stores the pooled cost per unit used when the item was sold.
--   2) create_sale fills it in.
--   3) Recalculation uses current_cost + pooled_cost, and keeps actual packaging when it was recorded.
-- Safe to run more than once.

-- 1) Column
alter table public.sale_items add column if not exists pooled_cost_satang bigint not null default 0;
alter table public.sale_items drop constraint if exists sale_items_pooled_cost_check;
alter table public.sale_items add constraint sale_items_pooled_cost_check check (pooled_cost_satang >= 0);

-- 2) Backfill existing menu items with the rate that create_sale logged for that sale.
--    Fallback: the owner's starting % in settings ("sales".initial_pooled_bps), then the app default 10%.
--    Only the per-unit amount is stored here; item/sale costs are corrected by the next recalculation
--    (ตั้งค่า → คำนวณต้นทุนย้อนหลัง), or when the menu is saved.
with logged_rate as (
  select distinct on (a.entity_id)
         a.entity_id as sale_id,
         (a.new_data->>'pooled_ingredient_bps')::integer as bps
  from public.audit_logs a
  where a.entity_type = 'sale' and a.action = 'created' and a.new_data ? 'pooled_ingredient_bps'
  order by a.entity_id, a.created_at desc
),
initial_rate as (
  select st.owner_id, nullif(st.value->>'initial_pooled_bps', '')::integer as bps
  from public.settings st
  where st.key = 'sales'
)
update public.sale_items si
set pooled_cost_satang = round(si.unit_price_satang * least(10000, greatest(0, coalesce(lr.bps, ir.bps, 1000))) / 10000.0)::bigint
from public.sales s
left join logged_rate lr on lr.sale_id = s.id
left join initial_rate ir on ir.owner_id = s.owner_id
where s.id = si.sale_id
  and si.menu_id is not null
  and si.pooled_cost_satang = 0;

-- 3) create_sale v5: same as v4 (202610150005) + stores pooled_cost_satang on each menu item.
create or replace function public.create_sale(payload jsonb) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
  v_sale_id uuid;
  v_item jsonb;
  v_menu public.menus%rowtype;
  v_pack public.packaging_items%rowtype;
  v_product bigint := 0;
  v_food bigint := 0;
  v_default_pack bigint := 0;
  v_pack_cost bigint := 0;
  v_cogs bigint;
  v_pool bigint;
  v_discount bigint := coalesce((payload->>'discount_satang')::bigint, 0);
  v_delivery bigint := coalesce((payload->>'delivery_charged_satang')::bigint, 0);
  v_tip bigint := coalesce((payload->>'tip_satang')::bigint, 0);
  v_fee bigint := coalesce((payload->>'payment_fee_satang')::bigint, 0);
  v_payment bigint := coalesce((payload->>'payment_amount_satang')::bigint, 0);
  v_bps integer := coalesce((payload->>'pooled_ingredient_bps')::integer, 0);
  v_fulfillment text := coalesce(payload->>'fulfillment', 'pickup');
  v_has_packaging boolean := coalesce(jsonb_typeof(payload->'packaging') = 'array', false);
  v_has_custom boolean := coalesce(jsonb_typeof(payload->'custom_items') = 'array', false);
  v_net bigint;
  v_quantity integer;
  v_custom_price bigint;
  v_custom_cost bigint;
  v_custom_name text;
  v_item_count integer := 0;
begin
  if v_owner is null then raise exception 'authentication required'; end if;
  if v_discount < 0 or v_delivery < 0 or v_tip < 0 or v_fee < 0 or v_payment < 0 then
    raise exception 'negative money is not allowed';
  end if;
  if v_bps < 0 or v_bps > 10000 then raise exception 'invalid pooled ingredient rate'; end if;
  if v_fulfillment not in ('pickup', 'delivery') then raise exception 'invalid fulfillment'; end if;

  -- 1. Process regular menu items
  if jsonb_typeof(payload->'items') = 'array' then
    for v_item in select * from jsonb_array_elements(payload->'items') loop
      v_quantity := (v_item->>'quantity')::integer;
      if v_quantity <= 0 then raise exception 'quantity must be positive'; end if;
      v_item_count := v_item_count + v_quantity;

      select * into v_menu from public.menus
        where id = (v_item->>'menu_id')::uuid and owner_id = v_owner and is_available = true for share;
      if not found then raise exception 'menu unavailable'; end if;

      v_pool := round(v_menu.selling_price_satang * v_bps / 10000.0)::bigint;
      v_product := v_product + v_menu.selling_price_satang * v_quantity;
      v_food := v_food + (greatest(0, v_menu.current_cost_satang - v_menu.packaging_cost_satang) + v_pool) * v_quantity;
      v_default_pack := v_default_pack + v_menu.packaging_cost_satang * v_quantity;
    end loop;
  end if;

  -- 2. Process custom quick items (e.g. rider delivery gigs, side services, ad-hoc purchases)
  if v_has_custom then
    for v_item in select * from jsonb_array_elements(payload->'custom_items') loop
      v_quantity := coalesce((v_item->>'quantity')::integer, 1);
      if v_quantity <= 0 then raise exception 'custom item quantity must be positive'; end if;
      v_item_count := v_item_count + v_quantity;

      v_custom_price := coalesce((v_item->>'price_satang')::bigint, 0);
      v_custom_cost := coalesce((v_item->>'cost_satang')::bigint, 0);
      if v_custom_price < 0 or v_custom_cost < 0 then raise exception 'custom price and cost cannot be negative'; end if;

      v_product := v_product + v_custom_price * v_quantity;
      v_food := v_food + v_custom_cost * v_quantity;
    end loop;
  end if;

  -- Must have at least one item, delivery charge, or tip
  if v_item_count = 0 and v_delivery = 0 and v_tip = 0 then
    raise exception 'at least one item or service fee is required';
  end if;

  -- 3. Packaging calculation
  if v_has_packaging then
    for v_item in select * from jsonb_array_elements(payload->'packaging') loop
      v_quantity := (v_item->>'quantity')::integer;
      if v_quantity < 0 then raise exception 'packaging quantity must be positive'; end if;
      continue when v_quantity = 0;
      select * into v_pack from public.packaging_items where id = (v_item->>'packaging_item_id')::uuid and owner_id = v_owner;
      if not found then raise exception 'packaging not found'; end if;
      v_pack_cost := v_pack_cost + round(v_pack.unit_cost_satang * v_quantity)::bigint;
    end loop;
  else
    v_pack_cost := v_default_pack;
  end if;

  v_cogs := v_food + v_pack_cost;
  -- Net revenue includes product revenue, delivery charged, and tip, minus discounts and payment fee
  v_net := v_product - v_discount + v_delivery + v_tip - v_fee;
  if v_net < 0 then raise exception 'net revenue cannot be negative'; end if;

  -- 4. Insert into sales table
  insert into public.sales(
    owner_id, sold_at, status, payment_status, customer_name, notes, fulfillment,
    product_revenue_satang, discount_satang, delivery_charged_satang, tip_satang,
    payment_fee_satang, packaging_cost_satang, net_revenue_satang, cogs_satang, gross_profit_satang
  ) values (
    v_owner, coalesce((payload->>'sold_at')::timestamptz, now()), 'confirmed',
    coalesce((payload->>'payment_status')::public.payment_status, 'paid'),
    payload->>'customer_name', payload->>'notes', v_fulfillment,
    v_product, v_discount, v_delivery, v_tip,
    v_fee, v_pack_cost, v_net, v_cogs, v_net - v_cogs
  ) returning id into v_sale_id;

  -- 5. Insert menu snapshot items
  if jsonb_typeof(payload->'items') = 'array' then
    for v_item in select * from jsonb_array_elements(payload->'items') loop
      v_quantity := (v_item->>'quantity')::integer;
      select * into v_menu from public.menus where id = (v_item->>'menu_id')::uuid and owner_id = v_owner;
      v_pool := round(v_menu.selling_price_satang * v_bps / 10000.0)::bigint;

      insert into public.menu_cost_snapshots(owner_id, menu_id, ingredient_cost_satang, packaging_cost_satang, labor_cost_satang, overhead_cost_satang, total_cost_satang)
        values(v_owner, v_menu.id, greatest(0, v_menu.current_cost_satang - v_menu.packaging_cost_satang) + v_pool, v_menu.packaging_cost_satang, 0, 0, v_menu.current_cost_satang + v_pool);

      insert into public.sale_items(
        owner_id, sale_id, menu_id, menu_name_snapshot, menu_category_snapshot,
        quantity, unit_price_satang, ingredient_cost_satang, packaging_cost_satang, pooled_cost_satang,
        labor_cost_satang, overhead_cost_satang, unit_cost_satang, unit_profit_satang,
        line_revenue_satang, line_cost_satang
      ) values (
        v_owner, v_sale_id, v_menu.id, v_menu.name, v_menu.category,
        v_quantity, v_menu.selling_price_satang,
        greatest(0, v_menu.current_cost_satang - v_menu.packaging_cost_satang) + v_pool,
        v_menu.packaging_cost_satang, v_pool, 0, 0,
        v_menu.current_cost_satang + v_pool,
        v_menu.selling_price_satang - v_menu.current_cost_satang - v_pool,
        v_menu.selling_price_satang * v_quantity,
        (v_menu.current_cost_satang + v_pool) * v_quantity
      );
    end loop;
  end if;

  -- 6. Insert custom quick items
  if v_has_custom then
    for v_item in select * from jsonb_array_elements(payload->'custom_items') loop
      v_quantity := coalesce((v_item->>'quantity')::integer, 1);
      v_custom_price := coalesce((v_item->>'price_satang')::bigint, 0);
      v_custom_cost := coalesce((v_item->>'cost_satang')::bigint, 0);
      v_custom_name := coalesce(v_item->>'name', 'รายการพิเศษ');

      insert into public.sale_items(
        owner_id, sale_id, menu_id, menu_name_snapshot, menu_category_snapshot,
        quantity, unit_price_satang, ingredient_cost_satang, packaging_cost_satang,
        labor_cost_satang, overhead_cost_satang, unit_cost_satang, unit_profit_satang,
        line_revenue_satang, line_cost_satang
      ) values (
        v_owner, v_sale_id, null, v_custom_name, 'พิเศษ',
        v_quantity, v_custom_price,
        v_custom_cost, 0, 0, 0,
        v_custom_cost,
        v_custom_price - v_custom_cost,
        v_custom_price * v_quantity,
        v_custom_cost * v_quantity
      );
    end loop;
  end if;

  -- 7. Insert packaging tracking
  if v_has_packaging then
    for v_item in select * from jsonb_array_elements(payload->'packaging') loop
      v_quantity := (v_item->>'quantity')::integer;
      continue when v_quantity = 0;
      select * into v_pack from public.packaging_items where id = (v_item->>'packaging_item_id')::uuid and owner_id = v_owner;
      insert into public.sale_packaging(owner_id, sale_id, packaging_item_id, name_snapshot, quantity, unit_cost_satang, line_cost_satang)
        values(v_owner, v_sale_id, v_pack.id, v_pack.name, v_quantity, v_pack.unit_cost_satang, round(v_pack.unit_cost_satang * v_quantity)::bigint);
    end loop;
  end if;

  -- 8. Payment & slip
  if v_payment > 0 then
    insert into public.payments(owner_id, sale_id, method, amount_satang, paid_at, reference_number)
      values(v_owner, v_sale_id, coalesce((payload->>'payment_method')::public.payment_method, 'cash'), v_payment, now(), payload->>'reference_number');
  end if;

  if payload ? 'slip' then
    insert into public.slip_uploads(owner_id, sale_id, storage_path, mime_type, size_bytes, file_hash_sha256, ocr_status)
      values(v_owner, v_sale_id, payload#>>'{slip,storage_path}', payload#>>'{slip,mime_type}', (payload#>>'{slip,size_bytes}')::bigint, payload#>>'{slip,file_hash_sha256}', 'pending');
  end if;

  insert into public.audit_logs(owner_id, entity_type, entity_id, action, new_data)
    values(v_owner, 'sale', v_sale_id, 'created', jsonb_build_object('net_revenue_satang', v_net, 'cogs_satang', v_cogs, 'packaging_cost_satang', v_pack_cost, 'tip_satang', v_tip, 'pooled_ingredient_bps', v_bps));

  return jsonb_build_object(
    'sale_id', v_sale_id,
    'product_revenue_satang', v_product,
    'net_revenue_satang', v_net,
    'cogs_satang', v_cogs,
    'tip_satang', v_tip,
    'packaging_cost_satang', v_pack_cost,
    'gross_profit_satang', v_net - v_cogs
  );
end $$;

revoke all on function public.create_sale(jsonb) from public, anon;
grant execute on function public.create_sale(jsonb) to authenticated;

-- 4) Recalculation v2
--    item cost  = current menu cost + pooled cost stored on the item
--    sale cogs  = Σ item food cost (line cost − default packaging) + packaging
--    packaging  = actual sale_packaging when recorded, otherwise the menus' default packaging
--    Items and sales are updated in separate statements so sale totals see the new item costs.
create or replace function public.recalculate_historical_sales_costs(
  p_menu_id uuid default null,
  p_force_all boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_owner uuid := auth.uid();
  v_updated_items int := 0;
  v_affected_sales int := 0;
  v_sale_ids uuid[];
begin
  if v_owner is null then
    raise exception 'authentication required';
  end if;

  -- 1. Sale items → current menu cost + their own pooled cost
  with targets as (
    select distinct on (si.id)
      si.id as sale_item_id,
      m.current_cost_satang + si.pooled_cost_satang as new_unit_cost,
      m.packaging_cost_satang as new_pack_cost,
      greatest(0, m.current_cost_satang - m.packaging_cost_satang) + si.pooled_cost_satang as new_ing_cost,
      si.unit_price_satang - (m.current_cost_satang + si.pooled_cost_satang) as new_profit,
      (m.current_cost_satang + si.pooled_cost_satang) * si.quantity as new_line_cost
    from public.sale_items si
    join public.menus m
      on m.owner_id = v_owner
     and (m.id = si.menu_id or (si.menu_id is null and lower(trim(m.name)) = lower(trim(si.menu_name_snapshot))))
    where si.owner_id = v_owner
      and m.current_cost_satang > 0
      and (p_menu_id is null or m.id = p_menu_id)
      and (
        p_force_all = true
        or coalesce(si.line_cost_satang, 0) = 0
        or coalesce(si.unit_cost_satang, 0) = 0
      )
    order by si.id, (m.id = si.menu_id) desc
  ),
  updated as (
    update public.sale_items si
    set
      unit_cost_satang = t.new_unit_cost,
      packaging_cost_satang = t.new_pack_cost,
      ingredient_cost_satang = t.new_ing_cost,
      unit_profit_satang = t.new_profit,
      line_cost_satang = t.new_line_cost
    from targets t
    where si.id = t.sale_item_id
      and (
        coalesce(si.unit_cost_satang, 0) != t.new_unit_cost
        or coalesce(si.line_cost_satang, 0) != t.new_line_cost
        or coalesce(si.packaging_cost_satang, 0) != t.new_pack_cost
        or coalesce(si.ingredient_cost_satang, 0) != t.new_ing_cost
      )
    returning si.sale_id
  )
  select count(*), coalesce(array_agg(distinct sale_id), '{}')
    into v_updated_items, v_sale_ids
  from updated;

  -- 2. Parent sale totals (separate statement: reads the item costs written above)
  with affected as (
    select unnest(v_sale_ids) as sale_id
    union
    select s.id from public.sales s
    where s.owner_id = v_owner
      and p_menu_id is null
      and (p_force_all = true or (s.status = 'confirmed' and coalesce(s.cogs_satang, 0) = 0))
  ),
  item_totals as (
    select
      si.sale_id,
      sum(greatest(0, coalesce(si.line_cost_satang, 0) - coalesce(si.packaging_cost_satang, 0) * coalesce(si.quantity, 1))) as food,
      sum(coalesce(si.packaging_cost_satang, 0) * coalesce(si.quantity, 1)) as default_pack
    from public.sale_items si
    where si.owner_id = v_owner
      and si.sale_id in (select sale_id from affected)
    group by si.sale_id
  ),
  actual_pack as (
    select sp.sale_id, sum(sp.line_cost_satang) as pack
    from public.sale_packaging sp
    where sp.owner_id = v_owner
      and sp.sale_id in (select sale_id from affected)
    group by sp.sale_id
  ),
  totals as (
    select it.sale_id,
           coalesce(ap.pack, it.default_pack) as pack,
           it.food + coalesce(ap.pack, it.default_pack) as cogs
    from item_totals it
    left join actual_pack ap on ap.sale_id = it.sale_id
  ),
  updated_sales as (
    update public.sales s
    set
      cogs_satang = t.cogs,
      packaging_cost_satang = t.pack,
      gross_profit_satang = s.net_revenue_satang - t.cogs
    from totals t
    where s.id = t.sale_id
      and s.owner_id = v_owner
      and (
        coalesce(s.cogs_satang, 0) != t.cogs
        or coalesce(s.packaging_cost_satang, 0) != t.pack
        or coalesce(s.gross_profit_satang, 0) != s.net_revenue_satang - t.cogs
      )
    returning s.id
  )
  select count(*) into v_affected_sales from updated_sales;

  return jsonb_build_object(
    'updated_items_count', v_updated_items,
    'affected_sales_count', v_affected_sales
  );
end $$;

revoke all on function public.recalculate_historical_sales_costs(uuid, boolean) from public, anon;
grant execute on function public.recalculate_historical_sales_costs(uuid, boolean) to authenticated;
