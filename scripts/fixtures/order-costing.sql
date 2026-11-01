begin;
create function pg_temp.assert_money(label text, actual numeric, expected numeric) returns void language plpgsql as $$
begin if actual is distinct from expected then raise exception '%: expected %, got %', label, expected, actual; end if; end $$;
create function pg_temp.reject_sale(payload jsonb) returns void language plpgsql as $$
declare rejected boolean := false; before_count bigint;
begin
  select count(*) into before_count from public.sales;
  begin perform public.create_sale(payload); exception when others then rejected := true; end;
  if not rejected then raise exception 'invalid sale accepted: %', payload; end if;
  perform pg_temp.assert_money('rejected sale leaves no partial rows', (select count(*) from public.sales), before_count);
end $$;
insert into auth.users(id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into public.menus(id,owner_id,name,category,selling_price_satang,current_cost_satang,packaging_cost_satang) values
('10000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ข้าวไก่69','เมนูหลัก',6900,3470,470),
('10000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ข้าวไก่89','เมนูหลัก',8900,4470,470),
('10000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','รับหิ้ว','บริการ',10000,0,0),
('10000000-0000-4000-8000-000000000004','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ข้าวเพิ่ม','เพิ่มเติม',1000,860,160),
('10000000-0000-4000-8000-000000000005','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Other shop','เมนูหลัก',6900,9999,0);
insert into public.packaging_items(id,owner_id,name,unit_cost_satang,per_order) values
('20000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','กล่อง',260,true),
('20000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ช้อน',160,true),
('20000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ถ้วย',50,true);
insert into public.menu_recipe_items(owner_id,menu_id,packaging_item_id,quantity)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',m.id,p.id,1 from public.menus m cross join public.packaging_items p
where m.id in ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002')
 or (m.id='10000000-0000-4000-8000-000000000004' and p.name='ช้อน');
set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
do $$
declare mixed jsonb; zero_pack jsonb; custom_sale jsonb; service jsonb; res jsonb; payload jsonb;
begin
  mixed := public.create_sale('{"items":[{"menu_id":"10000000-0000-4000-8000-000000000001","quantity":2},{"menu_id":"10000000-0000-4000-8000-000000000002","quantity":1},{"menu_id":"10000000-0000-4000-8000-000000000004","quantity":1},{"menu_id":"10000000-0000-4000-8000-000000000003","quantity":1}],"pooled_ingredient_bps":1250,"discount_satang":500,"delivery_charged_satang":1500,"tip_satang":200,"payment_fee_satang":100,"payment_amount_satang":34900}');
  perform pg_temp.assert_money('mixed product', (mixed->>'product_revenue_satang')::bigint,33700);
  perform pg_temp.assert_money('mixed net', (mixed->>'net_revenue_satang')::bigint,34800);
  perform pg_temp.assert_money('mixed cogs', (mixed->>'cogs_satang')::bigint,15074);
  perform pg_temp.assert_money('mixed actual pack', (mixed->>'packaging_cost_satang')::bigint,1410);
  perform pg_temp.assert_money('mixed profit', (mixed->>'gross_profit_satang')::bigint,19726);
  perform pg_temp.assert_money('default packaging persisted', (select count(*) from public.sale_packaging where sale_id=(mixed->>'sale_id')::uuid),3);
  perform pg_temp.assert_money('service pooled cost', (select pooled_cost_satang from public.sale_items where sale_id=(mixed->>'sale_id')::uuid and menu_id='10000000-0000-4000-8000-000000000003'),0);
  zero_pack := public.create_sale('{"items":[{"menu_id":"10000000-0000-4000-8000-000000000001","quantity":1}],"packaging":[],"pooled_ingredient_bps":1250,"payment_amount_satang":6900}');
  perform pg_temp.assert_money('no packaging cogs',(zero_pack->>'cogs_satang')::bigint,3863);
  custom_sale := public.create_sale('{"custom_items":[{"name":"ข้าวไก่69","price_satang":2000,"cost_satang":777}],"packaging":[],"payment_amount_satang":2000}');
  service := public.create_sale('{"items":[{"menu_id":"10000000-0000-4000-8000-000000000003","quantity":1}],"pooled_ingredient_bps":1250,"payment_amount_satang":10000}');
  perform pg_temp.assert_money('service cogs',(service->>'cogs_satang')::bigint,0);
  res := public.create_sale('{"items":[{"menu_id":"10000000-0000-4000-8000-000000000001","quantity":1},{"menu_id":"10000000-0000-4000-8000-000000000004","quantity":3}],"payment_amount_satang":9900}');
  perform pg_temp.assert_money('shared addon packaging max rule',(res->>'packaging_cost_satang')::bigint,790);
  perform pg_temp.assert_money('shared addon packaging cogs',(res->>'cogs_satang')::bigint,5890);
  update public.packaging_items set unit_cost_satang=10.075 where name='ถ้วย';
  res := public.create_sale('{"custom_items":[{"name":"fractional","price_satang":2000}],"packaging":[{"packaging_item_id":"20000000-0000-4000-8000-000000000003","quantity":100}],"payment_amount_satang":2000}');
  perform pg_temp.assert_money('decimal packaging rounds once per line',(res->>'packaging_cost_satang')::bigint,1008);
  update public.packaging_items set unit_cost_satang=50 where name='ถ้วย';
  res := public.recalculate_order_costs(null,true);
  perform pg_temp.assert_money('zero pack after recalculation',(select cogs_satang from public.sales where id=(zero_pack->>'sale_id')::uuid),3863);
  perform pg_temp.assert_money('custom cost preserved',(select cogs_satang from public.sales where id=(custom_sale->>'sale_id')::uuid),777);
  perform pg_temp.assert_money('mixed total still reconciles',(select cogs_satang from public.sales where id=(mixed->>'sale_id')::uuid),15074);
  perform pg_temp.assert_money('repeated run changes no bills',(public.recalculate_order_costs(null,true)->>'affected_sales_count')::bigint,0);
  -- Partial/unpaid receipts must be compared with customer due, never net after fees.
  perform public.create_sale('{"items":[{"menu_id":"10000000-0000-4000-8000-000000000001","quantity":1}],"payment_fee_satang":200,"payment_status":"partial","payment_amount_satang":5000}');
  perform public.create_sale('{"delivery_charged_satang":1500,"payment_status":"unpaid","payment_amount_satang":0}');
  perform public.create_sale('{"tip_satang":100,"payment_amount_satang":100}');
  payload := '{"items":[{"menu_id":"10000000-0000-4000-8000-000000000001","quantity":1}],"payment_amount_satang":6900}';
  perform pg_temp.reject_sale(payload || '{"discount_satang":6901}');
  perform pg_temp.reject_sale(payload || '{"payment_amount_satang":6800}');
  perform pg_temp.reject_sale(payload || '{"payment_status":"unpaid"}');
  perform pg_temp.reject_sale(payload || '{"expected_cogs_satang":99999}');
  perform pg_temp.reject_sale(payload || '{"payment_fee_satang":0.5}');
  perform pg_temp.reject_sale('{"items":[{"menu_id":"10000000-0000-4000-8000-000000000001","quantity":1.5}],"payment_amount_satang":6900}');
  perform pg_temp.reject_sale('{"items":[{"menu_id":"10000000-0000-4000-8000-000000000005","quantity":1}],"payment_amount_satang":6900}');
  perform pg_temp.reject_sale(payload || '{"packaging":[{"packaging_item_id":"20000000-0000-4000-8000-000000000001","quantity":1.5}]}');
  raise notice 'PASS: mixed orders, services, custom, default/zero packaging, payments, validation, repeatability';
end $$;
-- More than 1000 sales and more than 1000 lines on one sale bypass Data API limits entirely.
do $$
declare result jsonb; bulk uuid; other uuid;
begin
  for n in 1..1005 loop
    perform public.create_sale('{"items":[{"menu_id":"10000000-0000-4000-8000-000000000001","quantity":1}],"packaging":[],"payment_amount_satang":6900}');
  end loop;
  bulk := (public.create_sale('{"custom_items":[{"name":"bulk","price_satang":0,"cost_satang":0}],"payment_amount_satang":0}')->>'sale_id')::uuid;
  insert into public.sale_items(owner_id,sale_id,menu_id,menu_name_snapshot,quantity,unit_price_satang,ingredient_cost_satang,packaging_cost_satang,pooled_cost_satang,labor_cost_satang,overhead_cost_satang,unit_cost_satang,unit_profit_satang,line_revenue_satang,line_cost_satang)
  select auth.uid(),bulk,'10000000-0000-4000-8000-000000000001','bulk',1,6900,3000,470,0,0,0,3470,3430,6900,3470 from generate_series(1,1001);
  update public.menus set current_cost_satang=4470 where id='10000000-0000-4000-8000-000000000001';
  result := public.recalculate_order_costs('10000000-0000-4000-8000-000000000001',true);
  perform pg_temp.assert_money('all bulk bill lines',(select cogs_satang from public.sales where id=bulk),4000*1001);
  perform pg_temp.assert_money('all 1005 zero-pack orders',(select count(*) from public.sales where cogs_satang=4000 and product_revenue_satang=6900),1005);
  raise notice 'PASS: >1000 bills, >1000 lines in one bill, menu-scoped totals';
end $$;
-- Legacy imports had a positive default total but no detailed packaging rows.
do $$
declare legacy uuid;
begin
  legacy := (public.create_sale('{"items":[{"menu_id":"10000000-0000-4000-8000-000000000001","quantity":1}],"packaging":[],"pooled_ingredient_bps":1250,"payment_amount_satang":6900}')->>'sale_id')::uuid;
  update public.sales set packaging_cost_satang=4600,cogs_satang=9463,gross_profit_satang=net_revenue_satang-9463 where id=legacy;
  perform public.recalculate_order_costs('10000000-0000-4000-8000-000000000001',false);
  perform pg_temp.assert_money('missing-cost repair does not reprice a complete legacy bill',(select packaging_cost_satang from public.sales where id=legacy),4600);
  perform public.recalculate_order_costs('10000000-0000-4000-8000-000000000001',true);
  perform pg_temp.assert_money('explicit full refresh repairs legacy default packaging',(select packaging_cost_satang from public.sales where id=legacy),470);
  perform pg_temp.assert_money('legacy ingredients and pooled cost are preserved',(select cogs_satang from public.sales where id=legacy),5333);
  perform pg_temp.assert_money('does not fabricate actual packaging quantities',(select count(*) from public.sale_packaging where sale_id=legacy),0);
  perform pg_temp.assert_money('repeated legacy correction is idempotent',(public.recalculate_order_costs('10000000-0000-4000-8000-000000000001',true)->>'affected_sales_count')::bigint,0);
  raise notice 'PASS: positive untracked legacy packaging reprices; explicit zero stays zero';
end $$;
reset role;
-- Simulate a failure after line changes; PostgreSQL must roll everything back.
create function pg_temp.fail_cost_update() returns trigger language plpgsql as $$
begin raise exception 'injected failure'; end $$;
create trigger fail_cost_update before update on public.sales for each row execute function pg_temp.fail_cost_update();
set local role authenticated;
do $$
declare old_cost bigint; rejected boolean := false;
begin
  select sum(line_cost_satang) into old_cost from public.sale_items;
  update public.menus set current_cost_satang=5470 where id='10000000-0000-4000-8000-000000000001';
  begin perform public.recalculate_order_costs(null,true); exception when others then rejected := true; end;
  if not rejected then raise exception 'expected injected failure'; end if;
  perform pg_temp.assert_money('failed run rolls back all item writes',(select sum(line_cost_satang) from public.sale_items),old_cost);
  raise notice 'PASS: transaction rollback after partial work';
end $$;
rollback;
