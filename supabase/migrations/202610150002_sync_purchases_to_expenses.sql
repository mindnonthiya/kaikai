-- Backfill historical ingredient purchases and packaging purchases into expenses.
-- Safe to run more than once.

-- 1) Ingredient purchases -> expenses (kind = 'direct' so they show in expenses list but don't double-deduct from net profit)
insert into public.expenses (owner_id, spent_at, category, kind, amount_satang, description, payee)
select
  p.owner_id,
  p.purchased_at,
  'วัตถุดิบ',
  'direct'::expense_kind,
  p.price_satang,
  case
    when p.purchased_quantity is not null and p.purchase_unit is not null
      then 'ซื้อ' || i.name || ' ' || trim(to_char(p.purchased_quantity, 'FM999,999,990.##')) || ' ' || p.purchase_unit
    else 'ซื้อ' || i.name
  end,
  p.vendor
from public.ingredient_purchases p
join public.ingredients i on i.id = p.ingredient_id
where p.price_satang > 0
  and not exists (
    select 1 from public.expenses e
    where e.owner_id = p.owner_id
      and e.spent_at = p.purchased_at
      and e.amount_satang = p.price_satang
      and e.category = 'วัตถุดิบ'
  );

-- 2) Packaging purchases -> expenses (kind = 'direct' for per-order items like boxes/spoons, 'operating' for bags)
insert into public.expenses (owner_id, spent_at, category, kind, amount_satang, description, payee)
select
  p.owner_id,
  p.purchased_at,
  'บรรจุภัณฑ์',
  (case when item.per_order then 'direct' else 'operating' end)::expense_kind,
  p.price_satang,
  case
    when p.pack_count > 1
      then 'ซื้อ' || item.name || ' ' || p.pack_count || ' แพ็ก (' || p.pack_quantity || ' ' || item.unit || ')'
    else 'ซื้อ' || item.name || ' ' || p.pack_quantity || ' ' || item.unit
  end,
  p.vendor
from public.packaging_purchases p
join public.packaging_items item on item.id = p.packaging_item_id
where p.price_satang > 0
  and p.expense_id is null
  and not exists (
    select 1 from public.expenses e
    where e.owner_id = p.owner_id
      and e.spent_at = p.purchased_at
      and e.amount_satang = p.price_satang
      and e.category = 'บรรจุภัณฑ์'
  );
