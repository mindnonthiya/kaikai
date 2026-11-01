-- READ-ONLY audit: SELECT only. No records, prices or historical costs are changed.
-- Run in Supabase > SQL Editor for the SAME project as the affected website.
-- Dates are Bangkok business dates. Change them if reviewing a different period.
-- Optional: replace NULL::uuid with a specific shop owner UUID to limit the report.
-- Unlinked / duplicate / high-price rows are review candidates, NOT proof of bad data.
with params as (
  select null::uuid as owner_id, date '2026-10-01' as start_day, date '2026-11-01' as end_day
), shops as (
  select p.id as owner_id, p.shop_name,
    ((x.start_day + make_interval(hours => greatest(0, least(12, coalesce((st.value->>'day_start_hour')::integer, 0)))))::timestamp at time zone 'Asia/Bangkok') as start_at,
    ((x.end_day + make_interval(hours => greatest(0, least(12, coalesce((st.value->>'day_start_hour')::integer, 0)))))::timestamp at time zone 'Asia/Bangkok') as end_at
  from public.profiles p cross join params x
  left join public.settings st on st.owner_id=p.id and st.key='sales'
  where x.owner_id is null or p.id=x.owner_id
), active as (
  select sh.* from shops sh where exists (
    select 1 from public.sales s where s.owner_id=sh.owner_id and s.status='confirmed' and s.sold_at>=sh.start_at and s.sold_at<sh.end_at
  )
), period_sales as (
  select s.* from public.sales s join active sh on sh.owner_id=s.owner_id
  where s.status='confirmed' and s.sold_at>=sh.start_at and s.sold_at<sh.end_at
), pack_purchase as (
  select pp.*, p.name,
    round(pp.price_satang / nullif(pp.pack_quantity,0) / 100, 6) as purchase_price_per_piece_baht,
    pp.pack_quantity/nullif(pp.pack_count,0) as pieces_per_pack,
    count(*) over(partition by pp.owner_id,pp.packaging_item_id,pp.purchased_at,pp.price_satang,pp.pack_quantity,pp.pack_count) as identical_purchase_rows
  from public.packaging_purchases pp join public.packaging_items p on p.id=pp.packaging_item_id and p.owner_id=pp.owner_id
), snapshot_cost as (
  select sp.owner_id,sp.packaging_item_id,sum(sp.quantity) as pieces,
    count(distinct sp.sale_id) as orders,
    min(sp.unit_cost_satang)/100.0 as min_recorded_piece_price_baht,
    max(sp.unit_cost_satang)/100.0 as max_recorded_piece_price_baht,
    sum(sp.line_cost_satang)/100.0 as recorded_packaging_cost_baht,
    sum(round(sp.quantity*p.unit_cost_satang))/100.0 as same_quantities_at_current_catalog_price_baht
  from public.sale_packaging sp join period_sales s on s.id=sp.sale_id and s.owner_id=sp.owner_id
  join public.packaging_items p on p.id=sp.packaging_item_id and p.owner_id=sp.owner_id
  group by sp.owner_id,sp.packaging_item_id
)
select sh.owner_id, sh.shop_name, jsonb_build_object(
  'schema_checks',jsonb_build_object(
    'has_pooled_cost_snapshot',exists(select 1 from information_schema.columns where table_schema='public' and table_name='sale_items' and column_name='pooled_cost_satang'),
    'has_atomic_recalculation',to_regprocedure('public.recalculate_order_costs(uuid,boolean)') is not null
  ),
  'period_start',sh.start_at,'period_end_exclusive',sh.end_at,
  'summary',(
    select jsonb_build_object(
      'orders',count(*),'net_revenue_baht',coalesce(sum(s.net_revenue_satang),0)/100.0,
      'stored_cogs_baht',coalesce(sum(s.cogs_satang),0)/100.0,
      'stored_packaging_baht',coalesce(sum(s.packaging_cost_satang),0)/100.0,
      'untracked_positive_packaging_orders',count(*) filter(where s.packaging_cost_satang>0 and not exists(select 1 from public.sale_packaging sp where sp.sale_id=s.id and sp.owner_id=s.owner_id)),
      'untracked_positive_packaging_baht',coalesce(sum(s.packaging_cost_satang) filter(where s.packaging_cost_satang>0 and not exists(select 1 from public.sale_packaging sp where sp.sale_id=s.id and sp.owner_id=s.owner_id)),0)/100.0,
      'stored_nonpackaging_cost_baht',coalesce(sum(s.cogs_satang-s.packaging_cost_satang),0)/100.0,
      'stored_pooled_food_cost_baht',(select coalesce(sum(coalesce((to_jsonb(si)->>'pooled_cost_satang')::bigint,0)*si.quantity),0)/100.0 from public.sale_items si join period_sales ps on ps.id=si.sale_id and ps.owner_id=si.owner_id where si.owner_id=sh.owner_id),
      'gross_profit_baht',coalesce(sum(s.net_revenue_satang-s.cogs_satang),0)/100.0,
      'operating_expenses_baht',(select coalesce(sum(e.amount_satang),0)/100.0 from public.expenses e where e.owner_id=sh.owner_id and e.spent_at>=sh.start_at and e.spent_at<sh.end_at and e.kind<>'direct'),
      'direct_purchase_expenses_baht',(select coalesce(sum(e.amount_satang),0)/100.0 from public.expenses e where e.owner_id=sh.owner_id and e.spent_at>=sh.start_at and e.spent_at<sh.end_at and e.kind='direct'),
      'profit_identity_mismatches',count(*) filter(where s.gross_profit_satang<>s.net_revenue_satang-s.cogs_satang)
    ) from period_sales s where s.owner_id=sh.owner_id
  ),
  'packaging_catalog',coalesce((
    select jsonb_agg(jsonb_build_object(
      'name',p.name,'per_order',p.per_order,'catalog_price_per_piece_baht',p.unit_cost_satang/100.0,
      'purchase_rows',(select count(*) from pack_purchase pp where pp.packaging_item_id=p.id and pp.owner_id=sh.owner_id),
      'unlinked_purchase_rows',(select count(*) from pack_purchase pp where pp.packaging_item_id=p.id and pp.owner_id=sh.owner_id and pp.expense_id is null),
      'weighted_all_purchase_price_per_piece_baht',(select round(sum(pp.price_satang)/nullif(sum(pp.pack_quantity),0)/100.0,6) from pack_purchase pp where pp.packaging_item_id=p.id and pp.owner_id=sh.owner_id),
      'weighted_linked_purchase_price_per_piece_baht',(select round(sum(pp.price_satang)/nullif(sum(pp.pack_quantity),0)/100.0,6) from pack_purchase pp where pp.packaging_item_id=p.id and pp.owner_id=sh.owner_id and pp.expense_id is not null)
    ) order by p.name) from public.packaging_items p where p.owner_id=sh.owner_id
  ),'[]'::jsonb),
  'packaging_review_candidates',coalesce((
    select jsonb_agg(to_jsonb(q)) from (
      select pp.id,pp.name,pp.purchased_at,pp.price_satang/100.0 as purchase_total_baht,pp.pack_count,
        pp.pack_quantity as total_pieces,pp.pieces_per_pack,pp.purchase_price_per_piece_baht,
        pp.expense_id is null as unlinked_to_expense,pp.identical_purchase_rows
      from pack_purchase pp where pp.owner_id=sh.owner_id and (
        pp.expense_id is null or pp.identical_purchase_rows>1 or (pp.pieces_per_pack<=1 and pp.price_satang/nullif(pp.pack_count,0)>=1000)
      ) order by pp.purchased_at desc,pp.id limit 100
    ) q
  ),'[]'::jsonb),
  'historical_packaging_snapshots',coalesce((
    select jsonb_agg(jsonb_build_object(
      'name',p.name,'pieces',ss.pieces,'orders',ss.orders,
      'min_recorded_piece_price_baht',ss.min_recorded_piece_price_baht,'max_recorded_piece_price_baht',ss.max_recorded_piece_price_baht,
      'recorded_cost_baht',ss.recorded_packaging_cost_baht,
      'comparison_at_current_catalog_price_baht',ss.same_quantities_at_current_catalog_price_baht
    ) order by p.name) from snapshot_cost ss join public.packaging_items p on p.id=ss.packaging_item_id
    where ss.owner_id=sh.owner_id
  ),'[]'::jsonb),
  'ingredient_catalog',coalesce((
    select jsonb_agg(jsonb_build_object(
      'name',i.name,'costing',i.costing,'base_unit',i.base_unit,'purchase_unit',i.purchase_unit,
      'units_per_purchase_unit',i.units_per_purchase_unit,'price_per_purchase_unit_baht',i.price_per_purchase_unit_satang/100.0,
      'recipe_unit_price_baht',i.weighted_unit_cost_satang/100.0,
      'purchase_rows',(select count(*) from public.ingredient_purchases ip where ip.owner_id=sh.owner_id and ip.ingredient_id=i.id),
      'purchase_rows_with_receipt',(select count(*) from public.ingredient_purchases ip where ip.owner_id=sh.owner_id and ip.ingredient_id=i.id and ip.receipt_path is not null),
      'purchase_rows_without_receipt',(select count(*) from public.ingredient_purchases ip where ip.owner_id=sh.owner_id and ip.ingredient_id=i.id and ip.receipt_path is null),
      'first_purchase_at',(select min(ip.purchased_at) from public.ingredient_purchases ip where ip.owner_id=sh.owner_id and ip.ingredient_id=i.id),
      'last_purchase_at',(select max(ip.purchased_at) from public.ingredient_purchases ip where ip.owner_id=sh.owner_id and ip.ingredient_id=i.id)
    ) order by i.name) from public.ingredients i where i.owner_id=sh.owner_id
  ),'[]'::jsonb),
  'menu_costs_and_recipes',coalesce((
    select jsonb_agg(jsonb_build_object(
      'menu',m.name,'price_baht',m.selling_price_satang/100.0,'catalog_cost_baht',m.current_cost_satang/100.0,
      'recipe_packaging_baht',m.packaging_cost_satang/100.0,
      'recipes',(select jsonb_agg(jsonb_build_object('item',coalesce(i.name,p.name),'quantity',r.quantity,'type',case when r.ingredient_id is not null then 'ingredient' else 'packaging' end))
        from public.menu_recipe_items r left join public.ingredients i on i.id=r.ingredient_id and i.owner_id=r.owner_id
        left join public.packaging_items p on p.id=r.packaging_item_id and p.owner_id=r.owner_id
        where r.owner_id=sh.owner_id and r.menu_id=m.id)
    ) order by m.name) from public.menus m where m.owner_id=sh.owner_id
  ),'[]'::jsonb)
) as cost_audit
from active sh order by sh.shop_name;
