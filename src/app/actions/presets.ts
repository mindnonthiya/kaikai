"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { PRICE_PRESETS_SETTINGS_KEY, invalidateQueryCache } from "@/lib/data/queries";
import type { PricePreset } from "@/lib/data/types";
import { InputError, dbError, runAction } from "@/lib/server-action";

export async function saveAllPricePresets(presets: PricePreset[]): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    // Validate each preset
    for (const p of presets) {
      if (!p.name?.trim()) throw new InputError("กรุณาระบุชื่อสูตรเปิดบิลด่วน");
      if (typeof p.amountSatang !== "number" || p.amountSatang <= 0) {
        throw new InputError(`ยอดเงินของสูตร "${p.name}" ไม่ถูกต้อง (ต้องมากกว่า 0)`);
      }
      if (!Array.isArray(p.items) || p.items.length === 0) {
        throw new InputError(`สูตร "${p.name}" ต้องมีรายการเมนูอย่างน้อย 1 รายการ`);
      }
      for (const item of p.items) {
        if (!item.menuId) throw new InputError(`มีเมนูในสูตร "${p.name}" ที่ไม่ได้เลือก`);
        if (!item.quantity || item.quantity <= 0) throw new InputError(`จำนวนเมนูในสูตร "${p.name}" ต้องมากกว่า 0`);
      }
    }

    const { error } = await supabase.from("settings").upsert(
      {
        owner_id: user.id,
        key: PRICE_PRESETS_SETTINGS_KEY,
        value: { presets },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,key" },
    );

    if (error) dbError(error);

    invalidateQueryCache("settings:presets");
    revalidatePath("/settings");
    revalidatePath("/sales/new");
    revalidatePath("/sales/import-slips");
    return { ok: true, message: "บันทึกสูตรเปิดบิลด่วนเรียบร้อยแล้ว" };
  });
}

export async function deletePricePreset(presetId: string): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const { data, error } = await supabase
      .from("settings")
      .select("value")
      .eq("key", PRICE_PRESETS_SETTINGS_KEY)
      .maybeSingle();

    if (error) dbError(error);

    const rawValue = data?.value as Record<string, unknown> | unknown[] | null | undefined;
    const list: PricePreset[] = Array.isArray(rawValue)
      ? (rawValue as PricePreset[])
      : Array.isArray(rawValue?.presets)
      ? (rawValue.presets as PricePreset[])
      : [];

    const updated = list.filter((p) => p.id !== presetId);

    const { error: upsertErr } = await supabase.from("settings").upsert(
      {
        owner_id: user.id,
        key: PRICE_PRESETS_SETTINGS_KEY,
        value: { presets: updated },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,key" },
    );

    if (upsertErr) dbError(upsertErr);

    invalidateQueryCache("settings:presets");
    revalidatePath("/settings");
    revalidatePath("/sales/new");
    revalidatePath("/sales/import-slips");
    return { ok: true, message: "ลบสูตรเปิดบิลด่วนแล้ว" };
  });
}
