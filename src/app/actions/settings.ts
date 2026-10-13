"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { InputError, dbError, money, runAction, text } from "@/lib/server-action";

/** Default delivery fee filled in when an order is marked “ส่ง”. Stored in settings (key "sales"). */
export async function saveSaleSettings(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const fee = money(form, "default_delivery_fee", "ค่าส่งเริ่มต้น", { required: true });
    const { error } = await supabase.from("settings").upsert(
      { owner_id: user.id, key: "sales", value: { default_delivery_fee_satang: fee }, updated_at: new Date().toISOString() },
      { onConflict: "owner_id,key" },
    );
    if (error) dbError(error);
    revalidatePath("/settings");
    revalidatePath("/sales/new");
    return { ok: true, message: "บันทึกค่าส่งเริ่มต้นแล้ว" };
  });
}

export async function saveProfile(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const shopName = text(form, "shop_name", "ชื่อร้าน", { max: 80 });
    const displayName = text(form, "display_name", "ชื่อของคุณ", { max: 80 });
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
