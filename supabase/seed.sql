-- Development only. Never run this file against production.
-- Local owner: owner@kaikai.local / KaikaiDemo123!
do $$
declare v_owner uuid := '11111111-1111-4111-8111-111111111111';
begin
  if not exists(select 1 from auth.users where id=v_owner) then
    insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,email_change,email_change_token_new,recovery_token)
    values('00000000-0000-0000-0000-000000000000',v_owner,'authenticated','authenticated','owner@kaikai.local',extensions.crypt('KaikaiDemo123!',extensions.gen_salt('bf')),now(),'{"provider":"email","providers":["email"]}','{"display_name":"เจ้าของร้าน","shop_name":"kaikai"}',now(),now(),'','','','');
    insert into auth.identities(id,provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
    values(gen_random_uuid(),v_owner::text,v_owner,jsonb_build_object('sub',v_owner::text,'email','owner@kaikai.local'),'email',now(),now(),now());
  end if;

  insert into public.ingredients(id,owner_id,name,category,base_unit,weighted_unit_cost_satang) values
    ('21111111-1111-4111-8111-111111111111',v_owner,'ไก่สะโพก','เนื้อสัตว์','กรัม',9),
    ('21111111-1111-4111-8111-111111111112',v_owner,'ข้าวหอมมะลิ','วัตถุดิบหลัก','กรัม',5),
    ('21111111-1111-4111-8111-111111111113',v_owner,'น้ำปลาและเครื่องปรุง','เครื่องปรุง','มิลลิลิตร',6)
  on conflict(owner_id,name) do nothing;
  insert into public.packaging_items(id,owner_id,name,unit,unit_cost_satang) values
    ('31111111-1111-4111-8111-111111111111',v_owner,'กล่องอาหาร','ชิ้น',450),
    ('31111111-1111-4111-8111-111111111112',v_owner,'ช้อนและส้อม','ชุด',180),
    ('31111111-1111-4111-8111-111111111113',v_owner,'ถุงหิ้ว','ใบ',70)
  on conflict(owner_id,name) do nothing;
  insert into public.menus(id,owner_id,name,category,selling_price_satang,labor_cost_satang,overhead_cost_satang,current_cost_satang,cost_calculated_at) values
    ('41111111-1111-4111-8111-111111111111',v_owner,'ข้าวไก่ต้มน้ำปลา','เมนูหลัก',6900,0,0,3025,now()),
    ('41111111-1111-4111-8111-111111111112',v_owner,'ข้าวไก่ต้มน้ำปลาพิเศษ','เมนูหลัก',8900,0,0,3985,now()),
    ('41111111-1111-4111-8111-111111111113',v_owner,'ไก่ต้มน้ำปลา (กับข้าว)','กับข้าว',8900,0,0,3985,now()),
    ('41111111-1111-4111-8111-111111111114',v_owner,'ข้าวเปล่า','เพิ่มเติม',1000,0,0,180,now())
  on conflict(owner_id,name) do nothing;
  insert into public.menu_recipe_items(id,owner_id,menu_id,ingredient_id,packaging_item_id,quantity) values
    ('51111111-1111-4111-8111-111111111111',v_owner,'41111111-1111-4111-8111-111111111111','21111111-1111-4111-8111-111111111111',null,5),
    ('51111111-1111-4111-8111-111111111112',v_owner,'41111111-1111-4111-8111-111111111111',null,'31111111-1111-4111-8111-111111111111',1),
    ('51111111-1111-4111-8111-111111111113',v_owner,'41111111-1111-4111-8111-111111111111',null,'31111111-1111-4111-8111-111111111112',1),
    ('51111111-1111-4111-8111-111111111114',v_owner,'41111111-1111-4111-8111-111111111113','21111111-1111-4111-8111-111111111111',null,7),
    ('51111111-1111-4111-8111-111111111115',v_owner,'41111111-1111-4111-8111-111111111113',null,'31111111-1111-4111-8111-111111111111',1),
    ('51111111-1111-4111-8111-111111111116',v_owner,'41111111-1111-4111-8111-111111111113',null,'31111111-1111-4111-8111-111111111112',1)
  on conflict(id) do nothing;
  insert into public.expenses(owner_id,spent_at,category,kind,amount_satang,description,payee,payment_method) values
    (v_owner,now()-interval '2 hour','ค่าแก๊ส','operating',92000,'ถังแก๊ส 2 ถัง','ร้านแก๊สเจริญ','cash'),
    (v_owner,now()-interval '1 day','บรรจุภัณฑ์','direct',67500,'กล่องอาหาร 150 ใบ','Pack Pro','transfer');
end $$;
