-- Migration 202610150005: Add tip_satang, nullable menu_id on sale_items, and upgrade create_sale v4 for tips & custom items
-- Supports rider side jobs, delivery-only orders, tips / overtransfers, and custom quick items.

-- 1) Add tip_satang to sales table if not exists
alter table public.sales add column if not exists tip_satang bigint not null default 0 check(tip_satang >= 0);

-- 2) Make menu_id nullable on sale_items so custom items (or ad-hoc delivery gigs) don't require a pre-created menu row
alter table public.sale_items alter column menu_id drop not null;

-- 3) Upgrade create_sale to v4
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
        quantity, unit_price_satang, ingredient_cost_satang, packaging_cost_satang,
        labor_cost_satang, overhead_cost_satang, unit_cost_satang, unit_profit_satang,
        line_revenue_satang, line_cost_satang
      ) values (
        v_owner, v_sale_id, v_menu.id, v_menu.name, v_menu.category,
        v_quantity, v_menu.selling_price_satang,
        greatest(0, v_menu.current_cost_satang - v_menu.packaging_cost_satang) + v_pool,
        v_menu.packaging_cost_satang, 0, 0,
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
