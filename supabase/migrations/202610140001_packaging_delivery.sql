-- v1-data step 3: packaging bought in packs, packaging counted per order, delivery and add-ons.
-- Run after 202610130002_app_data.sql. Safe to run more than once.

-- 1) Packaging items
--    unit cost may be a fraction of a satang (e.g. 65 ฿ / 24 boxes), and each item says whether its
--    cost is counted per order (boxes, spoons, sauce cups) or booked as an expense when bought (bags).
alter table public.packaging_items
  alter column unit_cost_satang type numeric(18,6) using unit_cost_satang::numeric(18,6);
alter table public.packaging_items
  add column if not exists per_order boolean not null default true;

-- 2) Packaging purchase history: "bought 1 pack of 25 for 65 ฿".
--    unit cost = total price of all purchases ÷ total pieces (weighted average), same as ingredients.
create table if not exists public.packaging_purchases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  packaging_item_id uuid not null references public.packaging_items(id) on delete restrict,
  purchased_at timestamptz not null default now(),
  price_satang bigint not null check (price_satang >= 0),
  pack_quantity numeric(16,4) not null check (pack_quantity > 0),
  vendor text,
  -- set when the item is not counted per order: the purchase is also recorded as an expense
  expense_id uuid references public.expenses(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 3) Menus
--    manual_food_cost_satang: food cost per dish typed by the owner (added to recipe ingredients).
--    packaging_cost_satang:   default packaging cost per dish from the recipe (part of current_cost).
alter table public.menus add column if not exists manual_food_cost_satang bigint not null default 0 check (manual_food_cost_satang >= 0);
alter table public.menus add column if not exists packaging_cost_satang bigint not null default 0 check (packaging_cost_satang >= 0);
-- Menus without a recipe kept their typed-in material cost inside current_cost: move it to the new column.
update public.menus m
  set manual_food_cost_satang = greatest(0, m.current_cost_satang - m.labor_cost_satang - m.overhead_cost_satang)
  where m.manual_food_cost_satang = 0
    and not exists (select 1 from public.menu_recipe_items r where r.menu_id = m.id);
update public.menus m
  set packaging_cost_satang = coalesce((
    select round(sum(r.quantity * p.unit_cost_satang))
    from public.menu_recipe_items r join public.packaging_items p on p.id = r.packaging_item_id
    where r.menu_id = m.id and p.per_order), 0);

-- 4) Sales: pickup or delivery, and the packaging actually handed out with the order.
alter table public.sales add column if not exists fulfillment text not null default 'pickup';
alter table public.sales drop constraint if exists sales_fulfillment_check;
alter table public.sales add constraint sales_fulfillment_check check (fulfillment in ('pickup','delivery'));
alter table public.sales add column if not exists packaging_cost_satang bigint not null default 0 check (packaging_cost_satang >= 0);
alter table public.sale_items add column if not exists menu_category_snapshot text;

create table if not exists public.sale_packaging (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  packaging_item_id uuid not null references public.packaging_items(id) on delete restrict,
  name_snapshot text not null,
  quantity integer not null check (quantity > 0),
  unit_cost_satang numeric(18,6) not null check (unit_cost_satang >= 0),
  line_cost_satang bigint not null check (line_cost_satang >= 0),
  created_at timestamptz not null default now()
);

-- 5) Row Level Security for the new tables (same owner-only rules as every other table).
do $$ declare t text; begin
  foreach t in array array['packaging_purchases','sale_packaging'] loop
    execute format('create index if not exists %I on public.%I(owner_id)', t||'_owner_idx', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "owner_select" on public.%I', t);
    execute format('drop policy if exists "owner_insert" on public.%I', t);
    execute format('drop policy if exists "owner_update" on public.%I', t);
    execute format('drop policy if exists "owner_delete" on public.%I', t);
    execute format('create policy "owner_select" on public.%I for select to authenticated using ((select auth.uid()) = owner_id)', t);
    execute format('create policy "owner_insert" on public.%I for insert to authenticated with check ((select auth.uid()) = owner_id)', t);
    execute format('create policy "owner_update" on public.%I for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id)', t);
    execute format('create policy "owner_delete" on public.%I for delete to authenticated using ((select auth.uid()) = owner_id)', t);
  end loop;
end $$;
create index if not exists packaging_purchases_item_idx on public.packaging_purchases(packaging_item_id, purchased_at desc);
create index if not exists sale_packaging_sale_idx on public.sale_packaging(sale_id);
grant select, insert, update, delete on public.packaging_purchases, public.sale_packaging to authenticated;

-- 6) create_sale v2
--    payload.packaging = [{ packaging_item_id, quantity }]  → packaging actually used (cost read from the DB).
--    Without payload.packaging the menus' default packaging is used.
--    cogs = Σ food cost per dish × qty + packaging cost.
--    sale_items keep each menu's full cost (with its default packaging) for per-menu profit reports.
create or replace function public.create_sale(payload jsonb) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_sale_id uuid; v_item jsonb; v_menu public.menus%rowtype; v_pack public.packaging_items%rowtype;
  v_product bigint := 0; v_food bigint := 0; v_default_pack bigint := 0; v_pack_cost bigint := 0; v_cogs bigint;
  v_discount bigint := coalesce((payload->>'discount_satang')::bigint,0);
  v_delivery bigint := coalesce((payload->>'delivery_charged_satang')::bigint,0);
  v_fee bigint := coalesce((payload->>'payment_fee_satang')::bigint,0);
  v_payment bigint := coalesce((payload->>'payment_amount_satang')::bigint,0);
  v_fulfillment text := coalesce(payload->>'fulfillment','pickup');
  v_has_packaging boolean := coalesce(jsonb_typeof(payload->'packaging') = 'array', false);
  v_net bigint; v_quantity integer;
begin
  if v_owner is null then raise exception 'authentication required'; end if;
  if jsonb_typeof(payload->'items') <> 'array' or jsonb_array_length(payload->'items') = 0 then raise exception 'at least one item is required'; end if;
  if v_discount < 0 or v_delivery < 0 or v_fee < 0 or v_payment < 0 then raise exception 'negative money is not allowed'; end if;
  if v_fulfillment not in ('pickup','delivery') then raise exception 'invalid fulfillment'; end if;

  for v_item in select * from jsonb_array_elements(payload->'items') loop
    v_quantity := (v_item->>'quantity')::integer; if v_quantity <= 0 then raise exception 'quantity must be positive'; end if;
    select * into v_menu from public.menus where id=(v_item->>'menu_id')::uuid and owner_id=v_owner and is_available=true for share;
    if not found then raise exception 'menu unavailable'; end if;
    v_product := v_product + v_menu.selling_price_satang*v_quantity;
    v_food := v_food + greatest(0, v_menu.current_cost_satang - v_menu.packaging_cost_satang)*v_quantity;
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
    insert into public.menu_cost_snapshots(owner_id,menu_id,ingredient_cost_satang,packaging_cost_satang,labor_cost_satang,overhead_cost_satang,total_cost_satang)
      values(v_owner,v_menu.id,greatest(0,v_menu.current_cost_satang-v_menu.labor_cost_satang-v_menu.overhead_cost_satang-v_menu.packaging_cost_satang),v_menu.packaging_cost_satang,v_menu.labor_cost_satang,v_menu.overhead_cost_satang,v_menu.current_cost_satang);
    insert into public.sale_items(owner_id,sale_id,menu_id,menu_name_snapshot,menu_category_snapshot,quantity,unit_price_satang,ingredient_cost_satang,packaging_cost_satang,labor_cost_satang,overhead_cost_satang,unit_cost_satang,unit_profit_satang,line_revenue_satang,line_cost_satang)
      values(v_owner,v_sale_id,v_menu.id,v_menu.name,v_menu.category,v_quantity,v_menu.selling_price_satang,greatest(0,v_menu.current_cost_satang-v_menu.labor_cost_satang-v_menu.overhead_cost_satang-v_menu.packaging_cost_satang),v_menu.packaging_cost_satang,v_menu.labor_cost_satang,v_menu.overhead_cost_satang,v_menu.current_cost_satang,v_menu.selling_price_satang-v_menu.current_cost_satang,v_menu.selling_price_satang*v_quantity,v_menu.current_cost_satang*v_quantity);
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
  insert into public.audit_logs(owner_id,entity_type,entity_id,action,new_data) values(v_owner,'sale',v_sale_id,'created',jsonb_build_object('net_revenue_satang',v_net,'cogs_satang',v_cogs,'packaging_cost_satang',v_pack_cost));
  return jsonb_build_object('sale_id',v_sale_id,'product_revenue_satang',v_product,'net_revenue_satang',v_net,'cogs_satang',v_cogs,'packaging_cost_satang',v_pack_cost,'gross_profit_satang',v_net-v_cogs);
end $$;
revoke all on function public.create_sale(jsonb) from public,anon;
grant execute on function public.create_sale(jsonb) to authenticated;
