-- Recalculate historical sales that have cogs_satang = 0 or missing item line costs.
-- Uses current menu recipe costs (current_cost_satang and packaging_cost_satang).
-- Safe to run multiple times.

-- 1) Update sale_items that have 0 or null line cost with current menu costs
with updated_items as (
  update public.sale_items si
  set
    ingredient_cost_satang = greatest(0, m.current_cost_satang - m.packaging_cost_satang),
    packaging_cost_satang = m.packaging_cost_satang,
    unit_cost_satang = m.current_cost_satang,
    unit_profit_satang = si.unit_price_satang - m.current_cost_satang,
    line_cost_satang = m.current_cost_satang * si.quantity
  from public.menus m
  where (m.id = si.menu_id or m.name = si.menu_name_snapshot)
    and m.current_cost_satang > 0
    and coalesce(si.line_cost_satang, 0) = 0
  returning si.sale_id
),
sale_totals as (
  select
    si.sale_id,
    sum(si.line_cost_satang) as total_cogs,
    sum(si.packaging_cost_satang * si.quantity) as total_pack
  from public.sale_items si
  where si.sale_id in (select sale_id from updated_items)
  group by si.sale_id
)
-- 2) Update sales with the newly computed COGS and gross profit
update public.sales s
set
  cogs_satang = st.total_cogs,
  packaging_cost_satang = coalesce(st.total_pack, 0),
  gross_profit_satang = s.net_revenue_satang - st.total_cogs
from sale_totals st
where s.id = st.sale_id
  and coalesce(s.cogs_satang, 0) = 0
  and st.total_cogs > 0;
