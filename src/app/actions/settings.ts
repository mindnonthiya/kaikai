"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { InputError, dbError, money, runAction, text } from "@/lib/server-action";
import { recalculateMenuCosts } from "@/lib/menu-cost";

/** Percent text (e.g. "10" or "12.5") → basis points (1000 / 1250). */
function percentBps(form: FormData, name: string, label: string) {
  const raw = String(form.get(name) ?? "").trim().replace(/%$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new InputError(`${label}ไม่ถูกต้อง (ใส่ตัวเลข เช่น 10 หรือ 12.5)`);
  const bps = Math.round(Number(raw) * 100);
  if (bps > 10_000) throw new InputError(`${label}ต้องไม่เกิน 100%`);
  return bps;
}

/**
 * Sale settings (settings key "sales"):
 * default delivery fee filled in when an order is marked “ส่ง”, and the starting % for other ingredients.
 */
export async function saveSaleSettings(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const fee = money(form, "default_delivery_fee", "ค่าส่งเริ่มต้น", { required: true });
    const initialPooledBps = percentBps(form, "initial_pooled_percent", "% วัตถุดิบอื่นเริ่มต้น");
    const { error } = await supabase.from("settings").upsert(
      { owner_id: user.id, key: "sales", value: { default_delivery_fee_satang: fee, initial_pooled_bps: initialPooledBps }, updated_at: new Date().toISOString() },
      { onConflict: "owner_id,key" },
    );
    if (error) dbError(error);
    revalidatePath("/settings");
    revalidatePath("/sales/new");
    revalidatePath("/menus");
    revalidatePath("/ingredients");
    revalidatePath("/dashboard");
    return { ok: true, message: "บันทึกการตั้งค่าการขายแล้ว" };
  });
}

export async function saveProfile(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const shopName = text(form, "shop_name", "ชื่อร้าน", { max: 80 });
    const rawDisplayName = form.get("display_name");
    const displayName = typeof rawDisplayName === "string" && rawDisplayName.trim()
      ? rawDisplayName.trim()
      : shopName;
    const { data, error } = await supabase.from("profiles")
      .update({ shop_name: shopName, display_name: displayName, updated_at: new Date().toISOString() })
      .eq("id", user.id).select("id");
    if (error) dbError(error);
    if (!data?.length) throw new InputError("ไม่พบโปรไฟล์ของบัญชีนี้ — กรุณาติดต่อผู้ดูแลระบบ");
    await supabase.auth.updateUser({ data: { shop_name: shopName, display_name: displayName } });
    revalidatePath("/", "layout");
    return { ok: true, message: "บันทึกข้อมูลร้านแล้ว" };
  });
}

export async function changePassword(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirm") ?? "");
    if (password.length < 8) throw new InputError("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
    if (password !== confirm) throw new InputError("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      if (error.code === "same_password") throw new InputError("รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม");
      if (error.code === "weak_password") throw new InputError("รหัสผ่านง่ายเกินไป กรุณาตั้งให้ยากขึ้น");
      throw new InputError(`เปลี่ยนรหัสผ่านไม่สำเร็จ: ${error.message}`);
    }
    return { ok: true, message: "เปลี่ยนรหัสผ่านแล้ว" };
  });
}

type Row = Record<string, unknown>;

/**
 * Recalculates COGS, packaging cost, and profits for historical sales whose items had 0 cost
 * (recorded before recipes/costs were configured).
 */
export async function syncHistoricalSalesCosts(): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    // 1) Ensure all menus with recipes have up-to-date costs computed first
    try {
      await recalculateMenuCosts(supabase);
    } catch (e) {
      console.warn("recalculateMenuCosts error:", e);
    }

    // 2) Fetch current menus with cost > 0
    const { data: menus, error: menuErr } = await supabase.from("menus")
      .select("id,name,current_cost_satang,packaging_cost_satang").eq("owner_id", user.id);
    if (menuErr) dbError(menuErr);
    const menuMap = new Map((menus as Row[]).map((m) => [String(m.id), m]));
    const nameMap = new Map((menus as Row[]).map((m) => [String(m.name).trim().toLowerCase(), m]));

    // 3) Fetch sale_items that have 0 or null line cost
    const { data: items, error: itemErr } = await supabase.from("sale_items")
      .select("id,sale_id,menu_id,menu_name_snapshot,quantity,unit_price_satang,line_cost_satang,unit_cost_satang").eq("owner_id", user.id);
    if (itemErr) dbError(itemErr);

    const affectedSaleIds = new Set<string>();
    let updatedCount = 0;
    for (const item of (items as Row[])) {
      if (Number(item.line_cost_satang) > 0 && Number(item.unit_cost_satang) > 0) continue;
      const m = menuMap.get(String(item.menu_id)) ?? nameMap.get(String(item.menu_name_snapshot).trim().toLowerCase());
      if (!m || Number(m.current_cost_satang) <= 0) continue;
      const qty = Number(item.quantity) || 1;
      const unitCost = Number(m.current_cost_satang);
      const packCost = Number(m.packaging_cost_satang) || 0;
      const ingredientCost = Math.max(0, unitCost - packCost);
      const unitPrice = Number(item.unit_price_satang) || 0;

      const { error: updateErr } = await supabase.from("sale_items").update({
        ingredient_cost_satang: ingredientCost,
        packaging_cost_satang: packCost,
        unit_cost_satang: unitCost,
        unit_profit_satang: unitPrice - unitCost,
        line_cost_satang: unitCost * qty,
      }).eq("id", String(item.id));
      if (updateErr) dbError(updateErr);

      affectedSaleIds.add(String(item.sale_id));
      updatedCount++;
    }

    // 4) Also check for any sales whose cogs_satang is 0 or null
    const { data: zeroCogsSales } = await supabase.from("sales")
      .select("id").eq("owner_id", user.id).eq("status", "confirmed").or("cogs_satang.eq.0,cogs_satang.is.null");
    for (const z of (zeroCogsSales ?? []) as Row[]) {
      affectedSaleIds.add(String(z.id));
    }

    // 5) Recalculate totals for all affected sales
    for (const saleId of affectedSaleIds) {
      const { data: saleItems, error: siErr } = await supabase.from("sale_items")
        .select("line_cost_satang,packaging_cost_satang,quantity").eq("sale_id", saleId);
      if (siErr) dbError(siErr);
      let totalCogs = 0, totalPack = 0;
      for (const si of (saleItems as Row[])) {
        totalCogs += Number(si.line_cost_satang) || 0;
        totalPack += (Number(si.packaging_cost_satang) || 0) * (Number(si.quantity) || 1);
      }
      const { data: saleData } = await supabase.from("sales").select("net_revenue_satang").eq("id", saleId).single();
      const net = Number((saleData as Row)?.net_revenue_satang ?? 0);
      const { error: saleUpdateErr } = await supabase.from("sales").update({
        cogs_satang: totalCogs,
        packaging_cost_satang: totalPack,
        gross_profit_satang: net - totalCogs,
      }).eq("id", saleId);
      if (saleUpdateErr) dbError(saleUpdateErr);
    }

    revalidatePath("/dashboard");
    revalidatePath("/reports");
    revalidatePath("/sales");
    return {
      ok: true,
      message: updatedCount > 0 || affectedSaleIds.size > 0
        ? `คำนวณต้นทุนย้อนหลังให้ออเดอร์เก่า ${affectedSaleIds.size} รายการ เรียบร้อยแล้ว`
        : "ออเดอร์ทั้งหมดมีข้อมูลต้นทุนครบถ้วนอยู่แล้ว",
    };
  });
}
