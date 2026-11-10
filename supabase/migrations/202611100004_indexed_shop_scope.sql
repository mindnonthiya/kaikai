-- Materialize the existing text-prefix scope as generated, indexed columns.
-- This keeps backward compatibility while allowing all high-volume reads to
-- filter in PostgreSQL instead of downloading every row for an owner.
alter table public.ingredients
  add column if not exists catalog_scope_id text generated always as (
    coalesce(substring(name from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default')
  ) stored;
alter table public.packaging_items
  add column if not exists catalog_scope_id text generated always as (
    coalesce(substring(name from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default')
  ) stored;
alter table public.menus
  add column if not exists shop_scope_id text generated always as (
    coalesce(substring(name from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default')
  ) stored;
alter table public.expenses
  add column if not exists shop_scope_id text generated always as (
    coalesce(substring(description from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default')
  ) stored;
alter table public.sales
  add column if not exists shop_scope_id text generated always as (
    coalesce(substring(coalesce(notes, '') from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default')
  ) stored;
alter table public.ingredient_purchases
  add column if not exists purchase_shop_scope_id text generated always as (
    coalesce(substring(coalesce(vendor, '') from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default')
  ) stored;
alter table public.packaging_purchases
  add column if not exists purchase_shop_scope_id text generated always as (
    coalesce(substring(coalesce(vendor, '') from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default')
  ) stored;

create index if not exists ingredients_owner_catalog_scope_idx
  on public.ingredients(owner_id, catalog_scope_id);
create index if not exists packaging_owner_catalog_scope_idx
  on public.packaging_items(owner_id, catalog_scope_id);
create index if not exists menus_owner_shop_scope_idx
  on public.menus(owner_id, shop_scope_id);
create index if not exists expenses_owner_shop_scope_date_idx
  on public.expenses(owner_id, shop_scope_id, spent_at desc);
create index if not exists sales_owner_shop_scope_date_idx
  on public.sales(owner_id, shop_scope_id, sold_at desc);
create index if not exists ingredient_purchases_owner_shop_scope_date_idx
  on public.ingredient_purchases(owner_id, purchase_shop_scope_id, purchased_at desc);
create index if not exists packaging_purchases_owner_shop_scope_date_idx
  on public.packaging_purchases(owner_id, purchase_shop_scope_id, purchased_at desc);

notify pgrst, 'reload schema';
