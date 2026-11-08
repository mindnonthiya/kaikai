-- Universal restaurant costing support:
-- 1) Adds recipe_yield to menus so a menu's recipe can represent either 1 serving (default = 1)
--    or a batch recipe (e.g. crepe batter pot yielding 30 sheets, soup pot yielding 80 bowls).
-- 2) Broadens is_service_menu food-keyword guard so non-chicken restaurants (crepe, noodle, cafe)
--    are not misclassified if a food menu happens to contain a word like "ค่าส่ง".
-- Safe to run more than once.

alter table public.menus
  add column if not exists recipe_yield numeric(12,4) not null default 1;

alter table public.menus
  drop constraint if exists menus_recipe_yield_check;

alter table public.menus
  add constraint menus_recipe_yield_check check (recipe_yield > 0);

create or replace function public.is_service_menu(category text, menu_name text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(trim(category), '') in ('บริการ', 'บริการ / จ็อบเสริม', 'จ็อบเสริม')
    or (coalesce(menu_name, '') ~ 'ส่งด่วน|รับหิ้ว|ค่าส่ง|ไรเดอร์|จ็อบเสริม'
        and coalesce(menu_name, '') !~ 'ข้าว|ไก่|หมู|เนื้อ|ปลา|กุ้ง|เครป|แป้ง|ก๋วยเตี๋ยว|บะหมี่|น้ำ|ชา|กาแฟ|ขนม|ปัง|โรตี');
$$;
