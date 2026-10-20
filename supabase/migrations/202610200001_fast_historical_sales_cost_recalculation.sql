-- Migration 202610200001: Fast RPC function to recalculate historical sales costs in PostgreSQL
-- Solves slow client-side N+1 loops by updating sale items and sales in batch.

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
begin
  if v_owner is null then
    raise exception 'authentication required';
  end if;

  -- 1. Update sale_items using current menu costs
  with targets as (
    select
      si.id as sale_item_id,
      si.sale_id,
      m.current_cost_satang as new_unit_cost,
      m.packaging_cost_satang as new_pack_cost,
      greatest(0, m.current_cost_satang - m.packaging_cost_satang) as new_ing_cost,
      si.unit_price_satang - m.current_cost_satang as new_profit,
      m.current_cost_satang * si.quantity as new_line_cost
    from public.sale_items si
    join public.menus m on (m.id = si.menu_id or lower(trim(m.name)) = lower(trim(si.menu_name_snapshot)))
    where si.owner_id = v_owner
      and m.owner_id = v_owner
      and m.current_cost_satang > 0
      and (p_menu_id is null or m.id = p_menu_id)
      and (
        p_force_all = true
        or coalesce(si.line_cost_satang, 0) = 0
        or coalesce(si.unit_cost_satang, 0) = 0
      )
      and (
        coalesce(si.unit_cost_satang, 0) != m.current_cost_satang
        or coalesce(si.line_cost_satang, 0) != (m.current_cost_satang * si.quantity)
        or coalesce(si.packaging_cost_satang, 0) != m.packaging_cost_satang
      )
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
    returning si.sale_id
  ),
  -- 2. Affected sales: sales with updated items OR sales with cogs = 0 or null
  affected_sales as (
    select sale_id from updated
    union
    select id as sale_id from public.sales
    where owner_id = v_owner
      and status = 'confirmed'
      and (cogs_satang = 0 or cogs_satang is null)
      and (p_menu_id is null)
  ),
  sale_totals as (
    select
      si.sale_id,
      sum(coalesce(si.line_cost_satang, 0)) as total_cogs,
      sum(coalesce(si.packaging_cost_satang, 0) * coalesce(si.quantity, 1)) as total_pack
    from public.sale_items si
    where si.sale_id in (select sale_id from affected_sales)
      and si.owner_id = v_owner
    group by si.sale_id
  ),
  updated_sales as (
    update public.sales s
    set
      cogs_satang = coalesce(st.total_cogs, 0),
      packaging_cost_satang = coalesce(st.total_pack, 0),
      gross_profit_satang = s.net_revenue_satang - coalesce(st.total_cogs, 0)
    from sale_totals st
    where s.id = st.sale_id
      and s.owner_id = v_owner
      and (
        coalesce(s.cogs_satang, 0) != coalesce(st.total_cogs, 0)
        or coalesce(s.packaging_cost_satang, 0) != coalesce(st.total_pack, 0)
      )
    returning s.id
  )
  select count(*) into v_updated_items from updated;
  select count(*) into v_affected_sales from updated_sales;

  return jsonb_build_object(
    'updated_items_count', v_updated_items,
    'affected_sales_count', v_affected_sales
  );
end $$;

revoke all on function public.recalculate_historical_sales_costs(uuid, boolean) from public, anon;
grant execute on function public.recalculate_historical_sales_costs(uuid, boolean) to authenticated;
