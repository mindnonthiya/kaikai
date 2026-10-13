-- v1-data: changes needed for the app to read/write real data.
-- Safe to run once on a database that already has 202610130001_initial_schema.sql.

-- 1) Ingredient unit cost keeps fractional satang.
--    Example: 950 ฿ / 10,000 g = 9.5 satang per gram. With bigint this was rounded,
--    and cheap per-gram/per-ml items could round down to 0.
alter table public.ingredients
  alter column weighted_unit_cost_satang type numeric(18,6)
  using weighted_unit_cost_satang::numeric(18,6);

-- 2) owner_id defaults to the signed-in user, so inserts cannot forget it.
--    RLS "owner_insert" still rejects any row whose owner_id is not auth.uid().
do $$ declare t text; begin
  foreach t in array array['ingredients','ingredient_purchases','packaging_items','menus','menu_recipe_items','menu_cost_snapshots','sales','sale_items','payments','expenses','slip_uploads','audit_logs','settings'] loop
    execute format('alter table public.%I alter column owner_id set default auth.uid()', t);
  end loop;
end $$;

-- 3) Make sure signed-in users can reach the tables through the Data API.
--    (Needed if "Automatically expose new tables" was turned off when the project was created.)
--    Row Level Security still limits every row to its owner.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
