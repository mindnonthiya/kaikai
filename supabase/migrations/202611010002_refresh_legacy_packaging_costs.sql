-- Fix legacy imports with a positive packaging total but no tracked packaging rows.
-- Installing this function does not change any existing sale or purchase.
-- Only an explicit full recalculation applies the current recipe defaults to those bills.
-- Each run is one transaction: failure rolls back line, packaging and bill updates together.
create or replace function public.recalculate_order_costs(
  p_menu_id uuid default null, p_force_all boolean default false
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_owner uuid := auth.uid();
  v_sale public.sales%rowtype;
  v_pack bigint;
  v_food bigint;
  v_default_pack bigint;
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
    select coalesce(sum(greatest(0, si.line_cost_satang - si.packaging_cost_satang * si.quantity)), 0),
           coalesce(sum(si.packaging_cost_satang * si.quantity), 0)
      into v_food, v_default_pack from public.sale_items si where si.sale_id = v_sale.id and si.owner_id = v_owner;
    -- Older imports used recipe defaults without sale_packaging rows. An explicit full
    -- recalculation must refresh their positive default total instead of freezing an old error.
    -- A recorded zero is an explicit no-packaging choice and is always preserved.
    -- Actual tracked quantities continue to take precedence, including a tracked zero cost.
    v_pack := coalesce(v_pack, case
      when p_force_all and v_sale.packaging_cost_satang > 0 then v_default_pack
      else v_sale.packaging_cost_satang end);
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

