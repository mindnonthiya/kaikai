"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { DEFAULT_DELIVERY_FEE_OPTIONS_SATANG, invalidateQueryCache } from "@/lib/data/queries";
import { bahtToSatang } from "@/lib/money";
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

function dayStartHourField(form: FormData) {
  const raw = String(form.get("day_start_hour") ?? "0").trim();
  if (!/^\d+$/.test(raw)) throw new InputError("เวลาเริ่มวันใหม่ไม่ถูกต้อง");
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 12) {
    throw new InputError("เวลาเริ่มวันใหม่ต้องอยู่ระหว่าง 00:00 ถึง 12:00 น.");
  }
  return hour;
}

/**
 * Sale settings (settings key "sales"):
 * default delivery fee filled in when an order is marked “ส่ง”, starting % for other ingredients, and business day start hour.
 */
function deliveryFeeOptionsField(form: FormData, defaultFeeSatang: number): number[] {
  const raw = String(form.get("delivery_fee_options") ?? "").trim();
  if (!raw) {
    return Array.from(new Set([defaultFeeSatang, ...DEFAULT_DELIVERY_FEE_OPTIONS_SATANG])).sort((a, b) => a - b);
  }
  const parts = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const parsed: number[] = [defaultFeeSatang];
  for (const part of parts) {
    let val: number;
    try {
      val = bahtToSatang(part);
    } catch {
      throw new InputError(`ตัวเลือกค่าส่ง “${part}” ไม่ถูกต้อง (ใส่ตัวเลขคั่นด้วยลูกน้ำ เช่น 15, 20)`);
    }
    if (val < 0) throw new InputError("ตัวเลือกค่าส่งต้องไม่ติดลบ");
    parsed.push(val);
  }
  return Array.from(new Set(parsed)).sort((a, b) => a - b);
}

export async function saveSaleSettings(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const fee = money(form, "default_delivery_fee", "ค่าส่งเริ่มต้น", { required: true });
    const deliveryFeeOptions = deliveryFeeOptionsField(form, fee);
    const initialPooledBps = percentBps(form, "initial_pooled_percent", "% วัตถุดิบอื่นเริ่มต้น");
    const showMenuImages = form.get("show_menu_images") === "on" || form.get("show_menu_images") === "true";
    const dayStartHour = dayStartHourField(form);
    const { error } = await supabase.from("settings").upsert(
      {
        owner_id: user.id,
        key: "sales",
        value: {
          default_delivery_fee_satang: fee,
          delivery_fee_options_satang: deliveryFeeOptions,
          initial_pooled_bps: initialPooledBps,
          show_menu_images: showMenuImages,
          day_start_hour: dayStartHour,
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
    revalidatePath("/sales/import-slips");
    revalidatePath("/menus");
    revalidatePath("/ingredients");
    revalidatePath("/dashboard");
    revalidatePath("/sales");
    revalidatePath("/expenses");
    revalidatePath("/reports");
    revalidatePath("/bank-check");
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

    const removeAvatar = form.get("remove_avatar") === "true";
    let avatarUrl: string | null | undefined = undefined;

    if (removeAvatar) {
      avatarUrl = null;
    } else {
      const avatarFile = form.get("avatar") as File | null;
      if (avatarFile && avatarFile.size > 0 && typeof avatarFile.arrayBuffer === "function") {
        if (avatarFile.size > 5 * 1024 * 1024) {
          throw new InputError("รูปโปรไฟล์ต้องมีขนาดไม่เกิน 5 MB");
        }
        const buffer = Buffer.from(await avatarFile.arrayBuffer());
        const ext = avatarFile.name.split(".").pop()?.toLowerCase() || "jpg";
        const cleanExt = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext) ? ext : "jpg";
        const randomPart = Math.random().toString(36).substring(2, 8);
        const filePath = `${user.id}/avatar_${Date.now()}_${randomPart}.${cleanExt}`;

        try {
          const { error: uploadError } = await supabase.storage
            .from("menu-images")
            .upload(filePath, buffer, {
              contentType: avatarFile.type || "image/jpeg",
              upsert: true,
            });

          if (!uploadError) {
            const { data: { publicUrl } } = supabase.storage.from("menu-images").getPublicUrl(filePath);
            avatarUrl = publicUrl;
          } else if (buffer.length <= 2 * 1024 * 1024) {
            avatarUrl = `data:${avatarFile.type || "image/jpeg"};base64,${buffer.toString("base64")}`;
          }
        } catch {
          if (buffer.length <= 2 * 1024 * 1024) {
            avatarUrl = `data:${avatarFile.type || "image/jpeg"};base64,${buffer.toString("base64")}`;
          }
        }
      }
    }

    const updatePayload: {
      shop_name: string;
      display_name: string;
      updated_at: string;
      avatar_url?: string | null;
    } = {
      shop_name: shopName,
      display_name: displayName,
      updated_at: new Date().toISOString(),
    };
    if (avatarUrl !== undefined) {
      updatePayload.avatar_url = avatarUrl;
    }

    let { data, error } = await supabase.from("profiles")
      .update(updatePayload)
      .eq("id", user.id).select("id");

    if (error && avatarUrl !== undefined) {
      delete updatePayload.avatar_url;
      const resFallback = await supabase.from("profiles")
        .update(updatePayload)
        .eq("id", user.id).select("id");
      data = resFallback.data;
      error = resFallback.error;
    }
    if (error) dbError(error);
    if (!data?.length) throw new InputError("ไม่พบโปรไฟล์ของบัญชีนี้ — กรุณาติดต่อผู้ดูแลระบบ");

    const authMeta: { shop_name: string; display_name: string; avatar_url?: string | null } = {
      shop_name: shopName,
      display_name: displayName,
    };
    if (avatarUrl !== undefined) {
      // Only set avatar_url in auth metadata if it is null (removed) or a valid HTTP URL.
      // Base64 strings must NEVER be stored in JWT user_metadata to avoid cookie size overflow (>4KB)
      // which causes session corruption and "โหลดข้อมูลไม่สำเร็จ".
      if (avatarUrl === null || avatarUrl.startsWith("http://") || avatarUrl.startsWith("https://")) {
        authMeta.avatar_url = avatarUrl;
      }
    }
    await supabase.auth.updateUser({ data: authMeta });

    invalidateQueryCache("profile");
    revalidatePath("/", "layout");
    return { ok: true, message: "บันทึกข้อมูลร้านและโปรไฟล์แล้ว" };
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

    invalidateQueryCache();
    revalidatePath("/menus");
    revalidatePath("/sales/new");
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
