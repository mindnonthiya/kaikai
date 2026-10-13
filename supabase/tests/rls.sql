begin;
select plan(4);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at) values
('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@test.local','x',now(),now()),
('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','00000000-0000-0000-0000-000000000000','authenticated','authenticated','b@test.local','x',now(),now());
insert into public.ingredients(owner_id,name,category,base_unit) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A secret','test','g'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B secret','test','g');

set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select is((select count(*)::integer from public.ingredients where name like '%secret'),1,'user A reads only own rows');
select ok(not exists(select 1 from public.ingredients where name='B secret'),'user A cannot read user B row');
select is((with changed as (update public.ingredients set name='hacked' where owner_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' returning 1) select count(*)::integer from changed),0,'cross-owner update affects no row');
select throws_ok($$insert into public.ingredients(owner_id,name,category,base_unit) values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','bad','x','g')$$,'42501',null,'user A cannot insert for user B');
select * from finish();
rollback;
