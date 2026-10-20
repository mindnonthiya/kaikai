"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { invalidateQueryCache } from "@/lib/data/queries";
import { InputError, dbError, money, runAction, text } from "@/lib/server-action";
import { syncHistoricalCosts } from "@/lib/historical-cost-sync";

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
    const showMenuImages = form.get("show_menu_images") === "on" || form.get("show_menu_images") === "true";
    const { error } = await supabase.from("settings").upsert(
      {
        owner_id: user.id,
        key: "sales",
        value: {
          default_delivery_fee_satang: fee,
          initial_pooled_bps: initialPooledBps,
          show_menu_images: showMenuImages,
        },
        updated_at: new Date().toISOString()
      },
      { onConflict: "owner_id,key" },
    );
    if (error) dbError(error);
    invalidateQueryCache("settings");
    invalidateQueryCache("pooled_rate");
    revalidatePath("/settings");
    revalidatePath("/sales/new");
    revalidatePath("/menus");
    revalidatePath("/ingredients");
    revalidatePath("/dashboard");
    return { ok: true, message: "บันทึกการตั้งค่าแล้ว" };
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
    invalidateQueryCache("profile");
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


/**
 * Recalculates COGS, packaging cost, and profits for historical sales using current menu recipes.
 */
export async function syncHistoricalSalesCosts(form?: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const forceAll = form ? (form.get("force_all") === "true" || form.get("force_all") === "1") : true;
    const menuId = form ? (form.get("menu_id") as string | undefined) : undefined;

    const res = await syncHistoricalCosts(supabase, {
      ownerId: user.id,
      menuId: menuId || undefined,
      forceAll,
    });

    revalidatePath("/dashboard");
    revalidatePath("/reports");
    revalidatePath("/sales");
    return {
      ok: true,
      message: res.updatedItemsCount > 0 || res.affectedSalesCount > 0
        ? `คำนวณต้นทุนย้อนหลังให้ออเดอร์เก่า ${res.affectedSalesCount} รายการ (${res.updatedItemsCount} รายการสินค้า) เรียบร้อยแล้ว`
        : "ข้อมูลต้นทุนของออเดอร์ทั้งหมดตรงกับสูตรปัจจุบันแล้ว",
    };
  });
}
