-- Order costing v6: food-only pooled cost, consistent default packaging, validated payments.
-- No historical purchase quantities, recipes or sales are changed by installing this migration.
create index if not exists sale_items_owner_sale_idx on public.sale_items(owner_id, sale_id);
create index if not exists sale_items_owner_menu_sale_idx on public.sale_items(owner_id, menu_id, sale_id);
create or replace function public.is_service_menu(category text, menu_name text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(trim(category), '') in ('บริการ', 'บริการ / จ็อบเสริม', 'จ็อบเสริม')
    or (coalesce(menu_name, '') ~ 'ส่งด่วน|รับหิ้ว|ค่าส่ง|ไรเดอร์|จ็อบเสริม'
        and coalesce(menu_name, '') !~ 'ข้าว|ไก่');
$$;

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
  v_due bigint;
  v_status public.payment_status := coalesce((payload->>'payment_status')::public.payment_status, 'paid');
  v_packaging jsonb;
  v_field text;
begin
  if v_owner is null then raise exception 'authentication required'; end if;
  if v_discount < 0 or v_delivery < 0 or v_tip < 0 or v_fee < 0 or v_payment < 0 then
    raise exception 'negative money is not allowed';
  end if;
  if v_bps < 0 or v_bps > 10000 then raise exception 'invalid pooled ingredient rate'; end if;
  if v_fulfillment not in ('pickup', 'delivery') then raise exception 'invalid fulfillment'; end if;

  foreach v_field in array array['discount_satang','delivery_charged_satang','tip_satang','payment_fee_satang','payment_amount_satang','pooled_ingredient_bps'] loop
    if payload ? v_field and coalesce(payload->>v_field, '') !~ '^[0-9]+$' then raise exception 'money must be whole satang'; end if;
  end loop;
  if payload ? 'packaging' and not v_has_packaging then raise exception 'invalid packaging array'; end if;
  if payload ? 'items' and jsonb_typeof(payload->'items') <> 'array' then raise exception 'invalid items array'; end if;
  if payload ? 'custom_items' and not v_has_custom then raise exception 'invalid custom items array'; end if;
  -- 1. Process regular menu items
  if jsonb_typeof(payload->'items') = 'array' then
    for v_item in select * from jsonb_array_elements(payload->'items') loop
      if coalesce(v_item->>'quantity', '') !~ '^[0-9]+$' then raise exception 'quantity must be a whole number'; end if;
      v_quantity := (v_item->>'quantity')::integer;
      if v_quantity is null or v_quantity <= 0 then raise exception 'quantity must be positive'; end if;
      v_item_count := v_item_count + v_quantity;

      select * into v_menu from public.menus
        where id = (v_item->>'menu_id')::uuid and owner_id = v_owner and is_available = true for share;
      if not found then raise exception 'menu unavailable'; end if;

      v_pool := case when public.is_service_menu(v_menu.category, v_menu.name) then 0
        else round(v_menu.selling_price_satang::numeric * v_bps / 10000)::bigint end;
      v_product := v_product + v_menu.selling_price_satang * v_quantity;
      v_food := v_food + (greatest(0, v_menu.current_cost_satang - v_menu.packaging_cost_satang) + v_pool) * v_quantity;
      v_default_pack := v_default_pack + v_menu.packaging_cost_satang * v_quantity;
    end loop;
  end if;

  -- 2. Process custom quick items (e.g. rider delivery gigs, side services, ad-hoc purchases)
  if v_has_custom then
    for v_item in select * from jsonb_array_elements(payload->'custom_items') loop
      if coalesce(v_item->>'quantity', '1') !~ '^[0-9]+$' then raise exception 'quantity must be a whole number'; end if;
      v_quantity := coalesce((v_item->>'quantity')::integer, 1);
      if v_quantity is null or v_quantity <= 0 then raise exception 'custom item quantity must be positive'; end if;
      v_item_count := v_item_count + v_quantity;

      if coalesce(v_item->>'price_satang', '0') !~ '^[0-9]+$' or coalesce(v_item->>'cost_satang', '0') !~ '^[0-9]+$' then
        raise exception 'custom money must be whole satang';
      end if;
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

  -- Explicit [] means no packaging; otherwise use the composer's dish/add-on max rule.
  if v_has_packaging then
    v_packaging := payload->'packaging';
  else
    select coalesce(jsonb_agg(jsonb_build_object('packaging_item_id', id, 'quantity', quantity)), '[]'::jsonb)
    into v_packaging from (
      select p.id, greatest(
        ceil(coalesce(sum(r.quantity * (j->>'quantity')::integer) filter (where trim(m.category) <> 'เพิ่มเติม'), 0)),
        ceil(coalesce(sum(r.quantity * (j->>'quantity')::integer) filter (where trim(m.category) = 'เพิ่มเติม'), 0))
      )::integer as quantity
      from jsonb_array_elements(coalesce(payload->'items', '[]'::jsonb)) j
      join public.menus m on m.id = (j->>'menu_id')::uuid and m.owner_id = v_owner
      join public.menu_recipe_items r on r.menu_id = m.id and r.owner_id = v_owner
      join public.packaging_items p on p.id = r.packaging_item_id and p.owner_id = v_owner and p.per_order and p.is_active
      where not public.is_service_menu(m.category, m.name)
      group by p.id
    ) defaults where quantity > 0;
  end if;
  for v_item in select * from jsonb_array_elements(v_packaging) loop
    if coalesce(v_item->>'quantity', '') !~ '^[0-9]+$' then raise exception 'packaging quantity must be a whole number'; end if;
    v_quantity := (v_item->>'quantity')::integer;
    continue when v_quantity = 0;
    select * into v_pack from public.packaging_items where id = (v_item->>'packaging_item_id')::uuid
      and owner_id = v_owner and is_active and per_order for share;
    if not found then raise exception 'packaging not found'; end if;
    v_pack_cost := v_pack_cost + round(v_pack.unit_cost_satang * v_quantity)::bigint;
  end loop;

  v_cogs := v_food + v_pack_cost;
  -- Net revenue includes product revenue, delivery charged, and tip, minus discounts and payment fee
  v_net := v_product - v_discount + v_delivery + v_tip - v_fee;
  if v_discount > v_product then raise exception 'ส่วนลดต้องไม่เกินยอดสินค้า'; end if;
  if v_net < 0 then raise exception 'ค่าธรรมเนียมต้องไม่เกินยอดรับ'; end if;
  v_due := v_product - v_discount + v_delivery + v_tip;
  if (v_status = 'paid' and v_payment <> v_due)
    or (v_status = 'partial' and (v_payment <= 0 or v_payment >= v_due))
    or (v_status = 'unpaid' and v_payment <> 0) or v_status = 'refunded' then
    raise exception 'ยอดรับเงินไม่ตรงกับสถานะชำระเงิน';
  end if;
  if (payload ? 'expected_net_revenue_satang' and (payload->>'expected_net_revenue_satang')::bigint <> v_net)
    or (payload ? 'expected_cogs_satang' and (payload->>'expected_cogs_satang')::bigint <> v_cogs) then
    raise exception 'ราคาหรือต้นทุนเปลี่ยนแล้ว กรุณารีเฟรชหน้าและตรวจยอดใหม่';
  end if;

  -- 4. Insert into sales table
  insert into public.sales(
    owner_id, sold_at, status, payment_status, customer_name, notes, fulfillment,
    product_revenue_satang, discount_satang, delivery_charged_satang, tip_satang,
    payment_fee_satang, packaging_cost_satang, net_revenue_satang, cogs_satang, gross_profit_satang
  ) values (
    v_owner, coalesce((payload->>'sold_at')::timestamptz, now()), 'confirmed',
    v_status,
    payload->>'customer_name', payload->>'notes', v_fulfillment,
    v_product, v_discount, v_delivery, v_tip,
    v_fee, v_pack_cost, v_net, v_cogs, v_net - v_cogs
  ) returning id into v_sale_id;

  -- 5. Insert menu snapshot items
  if jsonb_typeof(payload->'items') = 'array' then
    for v_item in select * from jsonb_array_elements(payload->'items') loop
      if coalesce(v_item->>'quantity', '') !~ '^[0-9]+$' then raise exception 'quantity must be a whole number'; end if;
      v_quantity := (v_item->>'quantity')::integer;
      select * into v_menu from public.menus where id = (v_item->>'menu_id')::uuid and owner_id = v_owner;
      v_pool := case when public.is_service_menu(v_menu.category, v_menu.name) then 0
        else round(v_menu.selling_price_satang::numeric * v_bps / 10000)::bigint end;

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
      if coalesce(v_item->>'quantity', '1') !~ '^[0-9]+$' then raise exception 'quantity must be a whole number'; end if;
      v_quantity := coalesce((v_item->>'quantity')::integer, 1);
      if coalesce(v_item->>'price_satang', '0') !~ '^[0-9]+$' or coalesce(v_item->>'cost_satang', '0') !~ '^[0-9]+$' then
        raise exception 'custom money must be whole satang';
      end if;
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
  if jsonb_array_length(v_packaging) > 0 then
    for v_item in select * from jsonb_array_elements(v_packaging) loop
      if coalesce(v_item->>'quantity', '') !~ '^[0-9]+$' then raise exception 'quantity must be a whole number'; end if;
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


-- Each run is one transaction: failure rolls back line, packaging and bill updates together.
create or replace function public.recalculate_order_costs(
  p_menu_id uuid default null, p_force_all boolean default false
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_pack bigint;
  v_food bigint;
  v_count integer;
  v_items integer := 0;
  v_sales integer := 0;
begin
  if v_owner is null then raise exception 'authentication required'; end if;
  for v_sale in
    select s.* from public.sales s
    where s.owner_id = v_owner and s.status = 'confirmed'
      and (p_menu_id is null or exists (
        select 1 from public.sale_items si where si.sale_id = s.id and si.menu_id = p_menu_id and si.owner_id = v_owner
      ))
      and (p_force_all or s.cogs_satang = 0 or exists (
        select 1 from public.sale_items si where si.sale_id = s.id and si.owner_id = v_owner
          and (si.unit_cost_satang = 0 or si.line_cost_satang = 0)
      ))
    order by s.id for update
  loop
    with costs as (
      select si.id, m.current_cost_satang as menu_cost, m.packaging_cost_satang as pack,
        case when public.is_service_menu(m.category, m.name) then 0 else si.pooled_cost_satang end as pool
      from public.sale_items si join public.menus m on m.id = si.menu_id and m.owner_id = v_owner
      where si.owner_id = v_owner and si.sale_id = v_sale.id
        and (p_menu_id is null or si.menu_id = p_menu_id)
        and (p_force_all or si.unit_cost_satang = 0 or si.line_cost_satang = 0)
    )
    update public.sale_items si set
      ingredient_cost_satang = greatest(0, c.menu_cost - c.pack) + c.pool,
      packaging_cost_satang = c.pack, pooled_cost_satang = c.pool,
      unit_cost_satang = c.menu_cost + c.pool,
      unit_profit_satang = si.unit_price_satang - c.menu_cost - c.pool,
      line_cost_satang = (c.menu_cost + c.pool) * si.quantity
    from costs c where si.id = c.id and (
      si.unit_cost_satang <> c.menu_cost + c.pool or si.packaging_cost_satang <> c.pack
      or si.line_cost_satang <> (c.menu_cost + c.pool) * si.quantity
      or si.pooled_cost_satang <> c.pool
    );
    get diagnostics v_count = row_count;
    v_items := v_items + v_count;

    if p_force_all then
      update public.sale_packaging sp set
        unit_cost_satang = case when p.per_order then p.unit_cost_satang else 0 end,
        line_cost_satang = case when p.per_order then round(p.unit_cost_satang * sp.quantity)::bigint else 0 end
      from public.packaging_items p
      where sp.sale_id = v_sale.id and sp.owner_id = v_owner and p.owner_id = v_owner and p.id = sp.packaging_item_id;
    end if;
    select sum(sp.line_cost_satang) into v_pack from public.sale_packaging sp
      where sp.sale_id = v_sale.id and sp.owner_id = v_owner;
    -- No tracking rows includes explicit no-packaging orders. Keep the recorded total, including zero.
    v_pack := coalesce(v_pack, v_sale.packaging_cost_satang);
    select coalesce(sum(greatest(0, si.line_cost_satang - si.packaging_cost_satang * si.quantity)), 0)
      into v_food from public.sale_items si where si.sale_id = v_sale.id and si.owner_id = v_owner;
    update public.sales set cogs_satang = v_food + v_pack, packaging_cost_satang = v_pack,
      gross_profit_satang = net_revenue_satang - v_food - v_pack, updated_at = now()
    where id = v_sale.id and owner_id = v_owner and (
      cogs_satang <> v_food + v_pack or packaging_cost_satang <> v_pack
      or gross_profit_satang <> net_revenue_satang - v_food - v_pack
    );
    get diagnostics v_count = row_count;
    v_sales := v_sales + v_count;
  end loop;
  insert into public.audit_logs(owner_id, entity_type, action, new_data)
    values(v_owner, 'cost_recalculation', 'recalculated', jsonb_build_object(
      'menu_id', p_menu_id, 'force_all', p_force_all, 'updated_items_count', v_items, 'affected_sales_count', v_sales));
  return jsonb_build_object('updated_items_count', v_items, 'affected_sales_count', v_sales);
end $$;
revoke all on function public.recalculate_order_costs(uuid, boolean) from public, anon;
grant execute on function public.recalculate_order_costs(uuid, boolean) to authenticated;

-- Keep existing callers on the same corrected rules.
create or replace function public.recalculate_historical_sales_costs(p_menu_id uuid default null, p_force_all boolean default false)
returns jsonb language sql security invoker set search_path = public, pg_temp as $$
  select public.recalculate_order_costs(p_menu_id, p_force_all);
$$;
