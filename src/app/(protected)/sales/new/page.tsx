import { PageTitle } from "@/components/page-title";
import { SaleComposer, type MenuOption } from "./sale-composer";
import { demoMenus } from "@/lib/demo-data";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

async function loadMenus(): Promise<MenuOption[]> {
  if (!hasSupabaseEnv) return demoMenus;
  const supabase = await createClient();
  const { data, error } = await supabase.from("menus").select("id,name,category,selling_price_satang,current_cost_satang").eq("is_available", true).order("name");
  if (error || !data?.length) return [];
  return data.map((menu) => ({ id: String(menu.id), name: String(menu.name), category: String(menu.category), price: Number(menu.selling_price_satang), cost: Number(menu.current_cost_satang), emoji: "🍗" }));
}

export default async function NewSalePage() {
  const menus = await loadMenus();
  return <><PageTitle eyebrow="บันทึกรายการ" title="เพิ่มยอดขาย" description="เลือกเมนู กำหนดจำนวน และตรวจยอดก่อนบันทึก" /><SaleComposer menus={menus} /></>;
}
