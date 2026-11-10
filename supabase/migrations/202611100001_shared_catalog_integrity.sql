-- Direct FK link between ingredient_purchases and expenses (matching packaging_purchases.expense_id).
-- Safe to run more than once.

alter table public.ingredient_purchases
  add column if not exists expense_id uuid references public.expenses(id) on delete set null;

create index if not exists ingredient_purchases_expense_idx
  on public.ingredient_purchases(expense_id);

-- Backfill using a stable one-to-one row number inside each exact purchase
-- group. This prevents two identical same-day purchases from claiming the
-- same expense row.
with purchase_rows as (
  select
    p.id as purchase_id,
    p.owner_id,
    p.purchased_at,
    p.price_satang,
    coalesce(p.receipt_path, '') as receipt_path,
    coalesce(
      substring(p.vendor from '^\[s:([a-zA-Z0-9_-]{1,36})\]'),
      substring(i.name from '^\[s:([a-zA-Z0-9_-]{1,36})\]'),
      'default'
    ) as shop_id,
    regexp_replace(i.name, '^\[s:[a-zA-Z0-9_-]{1,36}\]', '') as item_name,
    row_number() over (
      partition by
        p.owner_id,
        p.purchased_at,
        p.price_satang,
        coalesce(p.receipt_path, ''),
        coalesce(
          substring(p.vendor from '^\[s:([a-zA-Z0-9_-]{1,36})\]'),
          substring(i.name from '^\[s:([a-zA-Z0-9_-]{1,36})\]'),
          'default'
        ),
        regexp_replace(i.name, '^\[s:[a-zA-Z0-9_-]{1,36}\]', '')
      order by p.created_at, p.id
    ) as pair_no
  from public.ingredient_purchases p
  join public.ingredients i on i.id = p.ingredient_id
  where p.expense_id is null
),
expense_rows as (
  select
    e.id as expense_id,
    e.owner_id,
    e.spent_at,
    e.amount_satang,
    coalesce(e.receipt_path, '') as receipt_path,
    coalesce(substring(e.description from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default') as shop_id,
    matched.item_name,
    row_number() over (
      partition by
        e.owner_id,
        e.spent_at,
        e.amount_satang,
        coalesce(e.receipt_path, ''),
        coalesce(substring(e.description from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default'),
        matched.item_name
      order by e.created_at, e.id
    ) as pair_no
  from public.expenses e
  cross join lateral (
    select regexp_replace(i.name, '^\[s:[a-zA-Z0-9_-]{1,36}\]', '') as item_name
    from public.ingredients i
    where i.owner_id = e.owner_id
      and regexp_replace(e.description, '^\[s:[a-zA-Z0-9_-]{1,36}\]', '') like
          'ซื้อ' || regexp_replace(i.name, '^\[s:[a-zA-Z0-9_-]{1,36}\]', '') || '%'
    order by length(regexp_replace(i.name, '^\[s:[a-zA-Z0-9_-]{1,36}\]', '')) desc
    limit 1
  ) matched
  where e.category = 'วัตถุดิบ'
),
matched as (
  select p.purchase_id, e.expense_id
  from purchase_rows p
  join expense_rows e
    on e.owner_id = p.owner_id
   and e.spent_at = p.purchased_at
   and e.amount_satang = p.price_satang
   and e.receipt_path = p.receipt_path
   and e.shop_id = p.shop_id
   and e.item_name = p.item_name
   and e.pair_no = p.pair_no
)
update public.ingredient_purchases p
set expense_id = m.expense_id
from matched m
where p.id = m.purchase_id
  and p.expense_id is null;

-- Repair duplicate links created by an earlier draft of this migration before
-- enforcing the one-expense-to-one-purchase invariant.
with duplicated as (
  select id,
         row_number() over (partition by expense_id order by created_at, id) as duplicate_no
  from public.ingredient_purchases
  where expense_id is not null
)
update public.ingredient_purchases p
set expense_id = null
from duplicated d
where p.id = d.id and d.duplicate_no > 1;

create unique index if not exists ingredient_purchases_expense_unique_idx
  on public.ingredient_purchases(expense_id)
  where expense_id is not null;

with duplicated as (
  select id,
         row_number() over (partition by expense_id order by created_at, id) as duplicate_no
  from public.packaging_purchases
  where expense_id is not null
)
update public.packaging_purchases p
set expense_id = null
from duplicated d
where p.id = d.id and d.duplicate_no > 1;

create unique index if not exists packaging_purchases_expense_unique_idx
  on public.packaging_purchases(expense_id)
  where expense_id is not null;

-- Recover the purchasing branch on legacy rows from their linked expense. New
-- writes already encode this marker, so the update only touches unprefixed rows.
update public.ingredient_purchases p
set vendor = case
  when coalesce(substring(e.description from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default') = 'default'
    then p.vendor
  else '[s:' || substring(e.description from '^\[s:([a-zA-Z0-9_-]{1,36})\]') || ']' || coalesce(p.vendor, '')
end
from public.expenses e
where p.expense_id = e.id
  and coalesce(p.vendor, '') !~ '^\[s:[a-zA-Z0-9_-]{1,36}\]';

update public.packaging_purchases p
set vendor = case
  when coalesce(substring(e.description from '^\[s:([a-zA-Z0-9_-]{1,36})\]'), 'default') = 'default'
    then p.vendor
  else '[s:' || substring(e.description from '^\[s:([a-zA-Z0-9_-]{1,36})\]') || ']' || coalesce(p.vendor, '')
end
from public.expenses e
where p.expense_id = e.id
  and coalesce(p.vendor, '') !~ '^\[s:[a-zA-Z0-9_-]{1,36}\]';

notify pgrst, 'reload schema';
