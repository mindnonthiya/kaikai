create extension if not exists pgcrypto with schema extensions;

create type public.payment_method as enum ('cash','transfer','other');
create type public.payment_status as enum ('unpaid','partial','paid','refunded');
create type public.sale_status as enum ('draft','confirmed','cancelled','refunded');
create type public.expense_kind as enum ('direct','operating','one_time','recurring');
create type public.ocr_status as enum ('pending','processing','needs_review','confirmed','failed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'เจ้าของร้าน',
  shop_name text not null default 'kaikai',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.ingredients (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null, category text not null, base_unit text not null, weighted_unit_cost_satang bigint not null default 0 check(weighted_unit_cost_satang >= 0),
  is_active boolean not null default true, notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(owner_id, name)
);
create table public.ingredient_purchases (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete restrict, purchased_at timestamptz not null default now(),
  price_satang bigint not null check(price_satang >= 0), purchased_quantity numeric(16,4) not null check(purchased_quantity > 0),
  usable_quantity numeric(16,4) not null check(usable_quantity > 0), purchase_unit text not null, vendor text, receipt_path text, notes text,
  created_at timestamptz not null default now()
);
create table public.packaging_items (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null, unit text not null default 'ชิ้น', unit_cost_satang bigint not null default 0 check(unit_cost_satang >= 0), is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(owner_id,name)
);
create table public.menus (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null, category text not null default 'เมนูหลัก', image_path text, selling_price_satang bigint not null check(selling_price_satang >= 0),
  labor_cost_satang bigint not null default 0 check(labor_cost_satang >= 0), overhead_cost_satang bigint not null default 0 check(overhead_cost_satang >= 0),
  current_cost_satang bigint not null default 0 check(current_cost_satang >= 0), is_available boolean not null default true, cost_calculated_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(owner_id,name)
);
create table public.menu_recipe_items (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  menu_id uuid not null references public.menus(id) on delete cascade, ingredient_id uuid references public.ingredients(id) on delete restrict,
  packaging_item_id uuid references public.packaging_items(id) on delete restrict, quantity numeric(16,4) not null check(quantity > 0),
  check ((ingredient_id is not null)::integer + (packaging_item_id is not null)::integer = 1)
);
create table public.menu_cost_snapshots (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  menu_id uuid not null references public.menus(id) on delete cascade, ingredient_cost_satang bigint not null, packaging_cost_satang bigint not null,
  labor_cost_satang bigint not null, overhead_cost_satang bigint not null, total_cost_satang bigint not null, calculated_at timestamptz not null default now(),
  check(ingredient_cost_satang >= 0 and packaging_cost_satang >= 0 and labor_cost_satang >= 0 and overhead_cost_satang >= 0 and total_cost_satang >= 0)
);
create table public.sales (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  sale_number bigint generated always as identity, sold_at timestamptz not null default now(), status public.sale_status not null default 'confirmed',
  payment_status public.payment_status not null default 'paid', customer_name text, notes text,
  product_revenue_satang bigint not null check(product_revenue_satang >= 0), discount_satang bigint not null default 0 check(discount_satang >= 0),
  delivery_charged_satang bigint not null default 0 check(delivery_charged_satang >= 0), payment_fee_satang bigint not null default 0 check(payment_fee_satang >= 0),
  net_revenue_satang bigint not null check(net_revenue_satang >= 0), cogs_satang bigint not null check(cogs_satang >= 0), gross_profit_satang bigint not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), cancelled_at timestamptz
);
create table public.sale_items (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade, menu_id uuid not null references public.menus(id) on delete restrict,
  menu_name_snapshot text not null, quantity integer not null check(quantity > 0), unit_price_satang bigint not null check(unit_price_satang >= 0),
  ingredient_cost_satang bigint not null check(ingredient_cost_satang >= 0), packaging_cost_satang bigint not null check(packaging_cost_satang >= 0),
  labor_cost_satang bigint not null check(labor_cost_satang >= 0), overhead_cost_satang bigint not null check(overhead_cost_satang >= 0),
  unit_cost_satang bigint not null check(unit_cost_satang >= 0), unit_profit_satang bigint not null, line_revenue_satang bigint not null, line_cost_satang bigint not null,
  created_at timestamptz not null default now()
);
create table public.payments (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade, method public.payment_method not null, amount_satang bigint not null check(amount_satang >= 0),
  paid_at timestamptz, reference_number text, created_at timestamptz not null default now()
);
create table public.expenses (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  spent_at timestamptz not null default now(), category text not null, kind public.expense_kind not null, amount_satang bigint not null check(amount_satang > 0),
  description text not null, payee text, receipt_path text, payment_method public.payment_method, notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.slip_uploads (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade, storage_path text not null, mime_type text not null check(mime_type in ('image/jpeg','image/png','image/webp')),
  size_bytes bigint not null check(size_bytes > 0 and size_bytes <= 10485760), file_hash_sha256 text not null, ocr_status public.ocr_status not null default 'pending',
  ocr_amount_satang bigint, ocr_transferred_at timestamptz, ocr_bank text, ocr_reference_number text, ocr_raw jsonb,
  user_confirmed_at timestamptz, created_at timestamptz not null default now(), unique(owner_id,file_hash_sha256)
);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null, entity_id uuid, action text not null, old_data jsonb, new_data jsonb, created_at timestamptz not null default now()
);
create table public.settings (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  key text not null, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now(), unique(owner_id,key)
);

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin insert into public.profiles(id,display_name,shop_name) values(new.id,coalesce(new.raw_user_meta_data->>'display_name','เจ้าของร้าน'),coalesce(new.raw_user_meta_data->>'shop_name','kaikai')) on conflict(id) do nothing; return new; end; $$;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

do $$ declare t text; begin
  foreach t in array array['ingredients','ingredient_purchases','packaging_items','menus','menu_recipe_items','menu_cost_snapshots','sales','sale_items','payments','expenses','slip_uploads','audit_logs','settings'] loop
    execute format('create index %I on public.%I(owner_id)', t||'_owner_idx', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "owner_select" on public.%I for select to authenticated using ((select auth.uid()) = owner_id)', t);
    execute format('create policy "owner_insert" on public.%I for insert to authenticated with check ((select auth.uid()) = owner_id)', t);
    execute format('create policy "owner_update" on public.%I for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id)', t);
    execute format('create policy "owner_delete" on public.%I for delete to authenticated using ((select auth.uid()) = owner_id)', t);
  end loop;
end $$;
alter table public.profiles enable row level security;
create policy "profile_select" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "profile_update" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create index ingredient_purchases_date_idx on public.ingredient_purchases(owner_id,purchased_at desc);
create index sales_sold_at_idx on public.sales(owner_id,sold_at desc);
create index expenses_spent_at_idx on public.expenses(owner_id,spent_at desc);
create index payments_sale_idx on public.payments(sale_id);
create index sale_items_sale_idx on public.sale_items(sale_id);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('sale-slips','sale-slips',false,10485760,array['image/jpeg','image/png','image/webp']) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy "slip_owner_select" on storage.objects for select to authenticated using(bucket_id='sale-slips' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "slip_owner_insert" on storage.objects for insert to authenticated with check(bucket_id='sale-slips' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "slip_owner_update" on storage.objects for update to authenticated using(bucket_id='sale-slips' and (storage.foldername(name))[1]=(select auth.uid())::text) with check(bucket_id='sale-slips' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "slip_owner_delete" on storage.objects for delete to authenticated using(bucket_id='sale-slips' and (storage.foldername(name))[1]=(select auth.uid())::text);

create or replace function public.create_sale(payload jsonb) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid(); v_sale_id uuid; v_item jsonb; v_menu public.menus%rowtype;
  v_product bigint := 0; v_cogs bigint := 0; v_discount bigint := coalesce((payload->>'discount_satang')::bigint,0);
  v_delivery bigint := coalesce((payload->>'delivery_charged_satang')::bigint,0); v_fee bigint := coalesce((payload->>'payment_fee_satang')::bigint,0);
  v_net bigint; v_quantity integer; v_payment bigint := coalesce((payload->>'payment_amount_satang')::bigint,0);
begin
  if v_owner is null then raise exception 'authentication required'; end if;
  if jsonb_typeof(payload->'items') <> 'array' or jsonb_array_length(payload->'items') = 0 then raise exception 'at least one item is required'; end if;
  if v_discount < 0 or v_delivery < 0 or v_fee < 0 or v_payment < 0 then raise exception 'negative money is not allowed'; end if;
  for v_item in select * from jsonb_array_elements(payload->'items') loop
    v_quantity := (v_item->>'quantity')::integer; if v_quantity <= 0 then raise exception 'quantity must be positive'; end if;
    select * into v_menu from public.menus where id=(v_item->>'menu_id')::uuid and owner_id=v_owner and is_available=true for share;
    if not found then raise exception 'menu unavailable'; end if;
    v_product := v_product + v_menu.selling_price_satang*v_quantity; v_cogs := v_cogs + v_menu.current_cost_satang*v_quantity;
  end loop;
  v_net := v_product-v_discount+v_delivery-v_fee; if v_net < 0 then raise exception 'net revenue cannot be negative'; end if;
  insert into public.sales(owner_id,sold_at,status,payment_status,customer_name,notes,product_revenue_satang,discount_satang,delivery_charged_satang,payment_fee_satang,net_revenue_satang,cogs_satang,gross_profit_satang)
    values(v_owner,coalesce((payload->>'sold_at')::timestamptz,now()),'confirmed',coalesce((payload->>'payment_status')::public.payment_status,'paid'),payload->>'customer_name',payload->>'notes',v_product,v_discount,v_delivery,v_fee,v_net,v_cogs,v_net-v_cogs) returning id into v_sale_id;
  for v_item in select * from jsonb_array_elements(payload->'items') loop
    v_quantity := (v_item->>'quantity')::integer; select * into v_menu from public.menus where id=(v_item->>'menu_id')::uuid and owner_id=v_owner;
    insert into public.menu_cost_snapshots(owner_id,menu_id,ingredient_cost_satang,packaging_cost_satang,labor_cost_satang,overhead_cost_satang,total_cost_satang)
      values(v_owner,v_menu.id,greatest(0,v_menu.current_cost_satang-v_menu.labor_cost_satang-v_menu.overhead_cost_satang),0,v_menu.labor_cost_satang,v_menu.overhead_cost_satang,v_menu.current_cost_satang);
    insert into public.sale_items(owner_id,sale_id,menu_id,menu_name_snapshot,quantity,unit_price_satang,ingredient_cost_satang,packaging_cost_satang,labor_cost_satang,overhead_cost_satang,unit_cost_satang,unit_profit_satang,line_revenue_satang,line_cost_satang)
      values(v_owner,v_sale_id,v_menu.id,v_menu.name,v_quantity,v_menu.selling_price_satang,greatest(0,v_menu.current_cost_satang-v_menu.labor_cost_satang-v_menu.overhead_cost_satang),0,v_menu.labor_cost_satang,v_menu.overhead_cost_satang,v_menu.current_cost_satang,v_menu.selling_price_satang-v_menu.current_cost_satang,v_menu.selling_price_satang*v_quantity,v_menu.current_cost_satang*v_quantity);
  end loop;
  if v_payment > 0 then insert into public.payments(owner_id,sale_id,method,amount_satang,paid_at,reference_number) values(v_owner,v_sale_id,coalesce((payload->>'payment_method')::public.payment_method,'cash'),v_payment,now(),payload->>'reference_number'); end if;
  if payload ? 'slip' then insert into public.slip_uploads(owner_id,sale_id,storage_path,mime_type,size_bytes,file_hash_sha256,ocr_status) values(v_owner,v_sale_id,payload#>>'{slip,storage_path}',payload#>>'{slip,mime_type}',(payload#>>'{slip,size_bytes}')::bigint,payload#>>'{slip,file_hash_sha256}','pending'); end if;
  insert into public.audit_logs(owner_id,entity_type,entity_id,action,new_data) values(v_owner,'sale',v_sale_id,'created',jsonb_build_object('net_revenue_satang',v_net,'cogs_satang',v_cogs));
  return jsonb_build_object('sale_id',v_sale_id,'product_revenue_satang',v_product,'net_revenue_satang',v_net,'cogs_satang',v_cogs,'gross_profit_satang',v_net-v_cogs);
end $$;
revoke all on function public.create_sale(jsonb) from public,anon;
grant execute on function public.create_sale(jsonb) to authenticated;
