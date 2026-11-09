"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { DEFAULT_DELIVERY_FEE_OPTIONS_SATANG, invalidateQueryCache } from "@/lib/data/queries";
import { DEFAULT_UNIT_LABEL } from "@/lib/data/types";
import { bahtToSatang } from "@/lib/money";
import { InputError, dbError, money, optionalText, runAction, text } from "@/lib/server-action";
import { syncHistoricalCosts } from "@/lib/historical-cost-sync";
import {
  ACTIVE_SHOP_COOKIE,
  DEFAULT_SHOP_ID,
  SHOPS_REGISTRY_SETTINGS_KEY,
  type ShopSummary,
  encodeShopText,
  matchesShopText,
  normalizeShopId,
  scopedSettingsKey,
  shopPrefix,
  stripShopPrefix,
} from "@/lib/shop-scope";

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
 * Sale settings (settings key "sales" or scoped "s:<shopId>:sales"):
 * default delivery fee filled in when an order is marked “ส่ง”, starting % for other ingredients, business day start hour, and primary unit label.
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
  return runAction(async ({ supabase, user, shopId }) => {
    const fee = money(form, "default_delivery_fee", "ค่าส่งเริ่มต้น", { required: true });
    const deliveryFeeOptions = deliveryFeeOptionsField(form, fee);
    const initialPooledBps = percentBps(form, "initial_pooled_percent", "% วัตถุดิบอื่นเริ่มต้น");
    const showMenuImages = form.get("show_menu_images") === "on" || form.get("show_menu_images") === "true";
    const dayStartHour = dayStartHourField(form);
    const unitLabel = optionalText(form, "unit_label", "คำเรียกหน่วยสินค้าหลัก", 20) || DEFAULT_UNIT_LABEL;
    const settingsKey = scopedSettingsKey("sales", shopId);
    const { error } = await supabase.from("settings").upsert(
      {
        owner_id: user.id,
        key: settingsKey,
        value: {
          default_delivery_fee_satang: fee,
          delivery_fee_options_satang: deliveryFeeOptions,
          initial_pooled_bps: initialPooledBps,
          show_menu_images: showMenuImages,
          day_start_hour: dayStartHour,
          unit_label: unitLabel,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,key" },
    );
    if (error) dbError(error);

    if (shopId !== DEFAULT_SHOP_ID) {
      const { data: regRow } = await supabase
        .from("settings")
        .select("value")
        .eq("owner_id", user.id)
        .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
        .maybeSingle();
      const rawShops = ((regRow?.value as { shops?: ShopSummary[] } | null)?.shops ?? []) as ShopSummary[];
      const nextShops = rawShops.map((s) => (s.id === shopId ? { ...s, unitLabel } : s));
      await supabase.from("settings").upsert(
        {
          owner_id: user.id,
          key: SHOPS_REGISTRY_SETTINGS_KEY,
          value: { shops: nextShops },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "owner_id,key" },
      );
    }

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
  return runAction(async ({ supabase, user, shopId }) => {
    const shopName = text(form, "shop_name", "ชื่อร้าน", { max: 80 });
    const rawDisplayName = form.get("display_name");
    const displayName =
      typeof rawDisplayName === "string" && rawDisplayName.trim()
        ? rawDisplayName.trim()
        : shopName;

    const removeAvatar = form.get("remove_avatar") === "true";
    const rawDataUrl = form.get("avatar_data_url");
    const avatarDataUrl =
      typeof rawDataUrl === "string" && rawDataUrl.trim().startsWith("data:image/")
        ? rawDataUrl.trim()
        : null;

    let avatarUrl: string | null | undefined = undefined;

    if (removeAvatar) {
      avatarUrl = null;
    } else if (avatarDataUrl && avatarDataUrl.length <= 2 * 1024 * 1024) {
      avatarUrl = avatarDataUrl;
    } else {
      const avatarFile = form.get("avatar") as File | null;
      if (avatarFile && avatarFile.size > 0 && typeof avatarFile.arrayBuffer === "function") {
        if (avatarFile.size > 5 * 1024 * 1024) {
          throw new InputError("รูปโปรไฟล์ต้องมีขนาดไม่เกิน 5 MB");
        }
        const buffer = Buffer.from(await avatarFile.arrayBuffer());
        const mimeType = avatarFile.type || "image/jpeg";
        if (buffer.length <= 2 * 1024 * 1024) {
          avatarUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
        } else {
          const ext = avatarFile.name.split(".").pop()?.toLowerCase() || "jpg";
          const cleanExt = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext) ? ext : "jpg";
          const randomPart = Math.random().toString(36).substring(2, 8);
          const filePath = `${user.id}/avatar_${Date.now()}_${randomPart}.${cleanExt}`;
          const { error: uploadError } = await supabase.storage
            .from("menu-images")
            .upload(filePath, buffer, {
              contentType: mimeType,
              upsert: true,
            });
          if (!uploadError) {
            const { data: { publicUrl } } = supabase.storage.from("menu-images").getPublicUrl(filePath);
            avatarUrl = publicUrl;
          }
        }
      }
    }

    const profileSettingsKey = scopedSettingsKey("profile", shopId);

    // 1. Persist to public.settings (key: "profile" or "s:<shopId>:profile")
    const { data: existingProfileSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", profileSettingsKey)
      .maybeSingle();
    const prevVal = (existingProfileSetting?.value ?? {}) as Record<string, unknown>;
    const resolvedAvatarUrl =
      avatarUrl !== undefined
        ? avatarUrl
        : typeof prevVal.avatar_url === "string"
        ? prevVal.avatar_url
        : prevVal.avatar_url === null
        ? null
        : undefined;

    const settingsPayload: Record<string, unknown> = {
      shop_name: shopName,
      display_name: displayName,
      ...(resolvedAvatarUrl !== undefined ? { avatar_url: resolvedAvatarUrl } : {}),
    };
    const { error: settingsErr } = await supabase.from("settings").upsert(
      {
        owner_id: user.id,
        key: profileSettingsKey,
        value: settingsPayload,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,key" },
    );
    if (settingsErr) dbError(settingsErr);

    if (shopId === DEFAULT_SHOP_ID) {
      // 2. Also update public.profiles and auth user_metadata for the primary shop
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
      if (resolvedAvatarUrl !== undefined) {
        updatePayload.avatar_url = resolvedAvatarUrl;
      }

      const { error: profileErr } = await supabase
        .from("profiles")
        .update(updatePayload)
        .eq("id", user.id);

      if (profileErr && resolvedAvatarUrl !== undefined) {
        delete updatePayload.avatar_url;
        await supabase.from("profiles").update(updatePayload).eq("id", user.id);
      }

      const authMeta: { shop_name: string; display_name: string; avatar_url?: string | null } = {
        shop_name: shopName,
        display_name: displayName,
      };
      if (resolvedAvatarUrl !== undefined) {
        if (
          resolvedAvatarUrl === null ||
          resolvedAvatarUrl.startsWith("http://") ||
          resolvedAvatarUrl.startsWith("https://")
        ) {
          authMeta.avatar_url = resolvedAvatarUrl;
        }
      }
      await supabase.auth.updateUser({ data: authMeta });
    } else {
      // Update secondary shop entry in shops_registry
      const { data: regRow } = await supabase
        .from("settings")
        .select("value")
        .eq("owner_id", user.id)
        .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
        .maybeSingle();
      const rawShops = ((regRow?.value as { shops?: ShopSummary[] } | null)?.shops ?? []) as ShopSummary[];
      const nextShops = rawShops.map((s) =>
        s.id === shopId
          ? {
              ...s,
              shopName,
              displayName,
              ...(resolvedAvatarUrl !== undefined ? { avatarUrl: resolvedAvatarUrl } : {}),
            }
          : s,
      );
      await supabase.from("settings").upsert(
        {
          owner_id: user.id,
          key: SHOPS_REGISTRY_SETTINGS_KEY,
          value: { shops: nextShops },
          updated_at: new Date().toISOString(),
        },
        { onConflict: "owner_id,key" },
      );
    }

    invalidateQueryCache("profile");
    invalidateQueryCache("settings");
    revalidatePath("/", "layout");
    return { ok: true, message: "บันทึกข้อมูลร้านและโปรไฟล์แล้ว" };
  });
}

export async function switchShopAction(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const requestedShopId = normalizeShopId(String(form.get("shop_id") ?? DEFAULT_SHOP_ID));
    let targetShopId = DEFAULT_SHOP_ID;

    if (requestedShopId !== DEFAULT_SHOP_ID) {
      const { data: regRow } = await supabase
        .from("settings")
        .select("value")
        .eq("owner_id", user.id)
        .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
        .maybeSingle();
      const rawShops = ((regRow?.value as { shops?: ShopSummary[] } | null)?.shops ?? []) as ShopSummary[];
      if (rawShops.some((s) => s && s.id === requestedShopId)) {
        targetShopId = requestedShopId;
      } else {
        throw new InputError("ไม่พบร้านที่คุณต้องการสลับไป");
      }
    }

    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_SHOP_COOKIE, targetShopId, {
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
      sameSite: "lax",
    });

    invalidateQueryCache();
    revalidatePath("/", "layout");
    return { ok: true, message: "สลับร้านเรียบร้อยแล้ว" };
  });
}

export async function createShopAction(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId: sourceShopId }) => {
    const shopName = text(form, "shop_name", "ชื่อร้านใหม่", { max: 80 });
    const rawDisplayName = optionalText(form, "display_name", "ชื่อผู้ขาย", 80);
    const unitLabel = optionalText(form, "unit_label", "คำเรียกหน่วยสินค้าหลัก", 20) || DEFAULT_UNIT_LABEL;
    const copyIngredients = form.get("copy_ingredients") === "on" || form.get("copy_ingredients") === "true";
    const copyMenus = form.get("copy_menus") === "on" || form.get("copy_menus") === "true";

    const { data: regRow } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
      .maybeSingle();
    const rawShops = ((regRow?.value as { shops?: ShopSummary[] } | null)?.shops ?? []) as ShopSummary[];

    if (rawShops.some((s) => s.shopName.trim().toLowerCase() === shopName.toLowerCase())) {
      throw new InputError(`มีร้านชื่อ “${shopName}” อยู่แล้ว`);
    }

    const newShopId = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const nowIso = new Date().toISOString();
    const displayName = rawDisplayName || shopName;

    const newShopEntry: ShopSummary = {
      id: newShopId,
      shopName,
      displayName,
      avatarUrl: null,
      unitLabel,
      createdAt: nowIso,
    };

    // 1. Update shops_registry
    const { error: regErr } = await supabase.from("settings").upsert(
      {
        owner_id: user.id,
        key: SHOPS_REGISTRY_SETTINGS_KEY,
        value: { shops: [...rawShops, newShopEntry] },
        updated_at: nowIso,
      },
      { onConflict: "owner_id,key" },
    );
    if (regErr) dbError(regErr);

    // 2. Save initial profile & sales settings for the new shop
    const { data: sourceSalesSetting } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", scopedSettingsKey("sales", sourceShopId))
      .maybeSingle();
    const srcSales = (sourceSalesSetting?.value ?? {}) as Record<string, unknown>;

    await supabase.from("settings").upsert(
      [
        {
          owner_id: user.id,
          key: scopedSettingsKey("profile", newShopId),
          value: {
            shop_name: shopName,
            display_name: displayName,
            avatar_url: null,
          },
          updated_at: nowIso,
        },
        {
          owner_id: user.id,
          key: scopedSettingsKey("sales", newShopId),
          value: {
            default_delivery_fee_satang: Number(srcSales.default_delivery_fee_satang ?? 1500),
            delivery_fee_options_satang: Array.isArray(srcSales.delivery_fee_options_satang)
              ? srcSales.delivery_fee_options_satang
              : DEFAULT_DELIVERY_FEE_OPTIONS_SATANG,
            initial_pooled_bps: Number(srcSales.initial_pooled_bps ?? 1000),
            show_menu_images: srcSales.show_menu_images !== false,
            day_start_hour: Number(srcSales.day_start_hour ?? 0),
            unit_label: unitLabel,
          },
          updated_at: nowIso,
        },
      ],
      { onConflict: "owner_id,key" },
    );

    // 3. Optionally clone ingredients & packaging from current shop
    const ingIdMap = new Map<string, string>();
    const packIdMap = new Map<string, string>();

    if (copyIngredients || copyMenus) {
      const [{ data: ingRows }, { data: packRows }, { data: packDefaultsRow }] = await Promise.all([
        supabase
          .from("ingredients")
          .select("id,name,costing,base_unit,purchase_unit,units_per_purchase_unit,unit_cost_satang,yield_auto,is_active")
          .eq("owner_id", user.id),
        supabase
          .from("packaging_items")
          .select("id,name,unit,per_order,unit_cost_satang,is_active")
          .eq("owner_id", user.id),
        supabase
          .from("settings")
          .select("value")
          .eq("owner_id", user.id)
          .eq("key", "packaging_defaults")
          .maybeSingle(),
      ]);

      const sourceIngredients = (ingRows ?? []).filter((r) =>
        matchesShopText(String((r as Record<string, unknown>).name ?? ""), sourceShopId),
      );
      for (const ing of sourceIngredients as Array<Record<string, unknown>>) {
        const cleanName = stripShopPrefix(String(ing.name ?? ""));
        const { data: insertedIng } = await supabase
          .from("ingredients")
          .insert({
            owner_id: user.id,
            name: encodeShopText(cleanName, newShopId),
            costing: ing.costing,
            base_unit: ing.base_unit,
            purchase_unit: ing.purchase_unit,
            units_per_purchase_unit: ing.units_per_purchase_unit,
            unit_cost_satang: ing.unit_cost_satang,
            yield_auto: ing.yield_auto,
            is_active: ing.is_active,
          })
          .select("id")
          .single();
        if (insertedIng) {
          ingIdMap.set(String(ing.id), String((insertedIng as Record<string, unknown>).id));
        }
      }

      const sourcePackagings = (packRows ?? []).filter((r) =>
        matchesShopText(String((r as Record<string, unknown>).name ?? ""), sourceShopId),
      );
      const packDefaultsMap: Record<string, unknown> = {
        ...((packDefaultsRow?.value ?? {}) as Record<string, unknown>),
      };
      let packDefaultsChanged = false;

      for (const pack of sourcePackagings as Array<Record<string, unknown>>) {
        const cleanName = stripShopPrefix(String(pack.name ?? ""));
        const { data: insertedPack } = await supabase
          .from("packaging_items")
          .insert({
            owner_id: user.id,
            name: encodeShopText(cleanName, newShopId),
            unit: pack.unit,
            per_order: pack.per_order,
            unit_cost_satang: pack.unit_cost_satang,
            is_active: pack.is_active,
          })
          .select("id")
          .single();
        if (insertedPack) {
          const oldId = String(pack.id);
          const newId = String((insertedPack as Record<string, unknown>).id);
          packIdMap.set(oldId, newId);
          if (packDefaultsMap[oldId]) {
            packDefaultsMap[newId] = packDefaultsMap[oldId];
            packDefaultsChanged = true;
          }
        }
      }

      if (packDefaultsChanged) {
        await supabase.from("settings").upsert(
          {
            owner_id: user.id,
            key: "packaging_defaults",
            value: packDefaultsMap,
            updated_at: nowIso,
          },
          { onConflict: "owner_id,key" },
        );
      }
    }

    // 4. Optionally clone menus & recipes from current shop
    if (copyMenus) {
      const [{ data: menuRows }, { data: menuYieldsRow }] = await Promise.all([
        supabase
          .from("menus")
          .select("id,name,category,image_url,price_satang,calculated_cost_satang,calculated_packaging_satang,target_margin_bps,is_active")
          .eq("owner_id", user.id),
        supabase
          .from("settings")
          .select("value")
          .eq("owner_id", user.id)
          .eq("key", "menu_yields")
          .maybeSingle(),
      ]);

      const sourceMenus = (menuRows ?? []).filter((r) =>
        matchesShopText(String((r as Record<string, unknown>).name ?? ""), sourceShopId),
      ) as Array<Record<string, unknown>>;

      const menuIdMap = new Map<string, string>();
      const yieldsMap: Record<string, number> = {
        ...((menuYieldsRow?.value ?? {}) as Record<string, number>),
      };
      let yieldsChanged = false;

      for (const m of sourceMenus) {
        const cleanName = stripShopPrefix(String(m.name ?? ""));
        const { data: insertedMenu } = await supabase
          .from("menus")
          .insert({
            owner_id: user.id,
            name: encodeShopText(cleanName, newShopId),
            category: m.category,
            image_url: m.image_url,
            price_satang: m.price_satang,
            calculated_cost_satang: m.calculated_cost_satang,
            calculated_packaging_satang: m.calculated_packaging_satang,
            target_margin_bps: m.target_margin_bps,
            is_active: m.is_active,
          })
          .select("id")
          .single();
        if (insertedMenu) {
          const oldMenuId = String(m.id);
          const newMenuId = String((insertedMenu as Record<string, unknown>).id);
          menuIdMap.set(oldMenuId, newMenuId);
          if (yieldsMap[oldMenuId] && yieldsMap[oldMenuId] > 1) {
            yieldsMap[newMenuId] = yieldsMap[oldMenuId];
            yieldsChanged = true;
          }
        }
      }

      if (yieldsChanged) {
        await supabase.from("settings").upsert(
          {
            owner_id: user.id,
            key: "menu_yields",
            value: yieldsMap,
            updated_at: nowIso,
          },
          { onConflict: "owner_id,key" },
        );
      }

      if (menuIdMap.size > 0) {
        const { data: recipeRows } = await supabase
          .from("menu_recipe_items")
          .select("menu_id,item_kind,ingredient_id,packaging_item_id,quantity,unit_cost_override_satang,notes,sort_order")
          .in("menu_id", Array.from(menuIdMap.keys()));

        const recipesToInsert: Array<Record<string, unknown>> = [];
        for (const r of (recipeRows ?? []) as Array<Record<string, unknown>>) {
          const newMenuId = menuIdMap.get(String(r.menu_id));
          if (!newMenuId) continue;
          const itemKind = String(r.item_kind);
          if (itemKind === "ingredient") {
            const newIngId = r.ingredient_id ? ingIdMap.get(String(r.ingredient_id)) : null;
            if (!newIngId) continue;
            recipesToInsert.push({
              owner_id: user.id,
              menu_id: newMenuId,
              item_kind: "ingredient",
              ingredient_id: newIngId,
              packaging_item_id: null,
              quantity: r.quantity,
              unit_cost_override_satang: r.unit_cost_override_satang,
              notes: r.notes,
              sort_order: r.sort_order,
            });
          } else if (itemKind === "packaging") {
            const newPackId = r.packaging_item_id ? packIdMap.get(String(r.packaging_item_id)) : null;
            if (!newPackId) continue;
            recipesToInsert.push({
              owner_id: user.id,
              menu_id: newMenuId,
              item_kind: "packaging",
              ingredient_id: null,
              packaging_item_id: newPackId,
              quantity: r.quantity,
              unit_cost_override_satang: r.unit_cost_override_satang,
              notes: r.notes,
              sort_order: r.sort_order,
            });
          }
        }

        if (recipesToInsert.length > 0) {
          await supabase.from("menu_recipe_items").insert(recipesToInsert);
        }
      }
    }

    // 5. Switch active shop cookie to the newly created shop
    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_SHOP_COOKIE, newShopId, {
      path: "/",
      maxAge: 365 * 24 * 60 * 60,
      sameSite: "lax",
    });

    invalidateQueryCache();
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: `สร้างร้าน “${shopName}” และสลับไปยังร้านใหม่เรียบร้อยแล้ว`,
    };
  });
}

export async function deleteShopAction(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId: currentActiveShopId }) => {
    const targetShopId = normalizeShopId(String(form.get("shop_id") ?? ""));
    if (!targetShopId || targetShopId === DEFAULT_SHOP_ID) {
      throw new InputError("ไม่สามารถลบร้านหลักได้");
    }

    const { data: regRow } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
      .maybeSingle();
    const rawShops = ((regRow?.value as { shops?: ShopSummary[] } | null)?.shops ?? []) as ShopSummary[];
    const targetShop = rawShops.find((s) => s.id === targetShopId);
    if (!targetShop) {
      throw new InputError("ไม่พบร้านที่ต้องการลบ");
    }

    const prefix = shopPrefix(targetShopId);

    // 1. Delete menus & recipe items of this shop
    const { data: shopMenus } = await supabase
      .from("menus")
      .select("id")
      .eq("owner_id", user.id)
      .like("name", `${prefix}%`);
    const shopMenuIds = (shopMenus ?? []).map((m) => String((m as Record<string, unknown>).id));
    if (shopMenuIds.length > 0) {
      await supabase.from("menu_recipe_items").delete().in("menu_id", shopMenuIds);
      await supabase.from("menus").delete().in("id", shopMenuIds);
    }

    // 2. Delete ingredients & purchases of this shop
    const { data: shopIngs } = await supabase
      .from("ingredients")
      .select("id")
      .eq("owner_id", user.id)
      .like("name", `${prefix}%`);
    const shopIngIds = (shopIngs ?? []).map((i) => String((i as Record<string, unknown>).id));
    if (shopIngIds.length > 0) {
      await supabase.from("ingredient_purchases").delete().in("ingredient_id", shopIngIds);
      await supabase.from("ingredients").delete().in("id", shopIngIds);
    }

    // 3. Delete packaging & purchases of this shop
    const { data: shopPacks } = await supabase
      .from("packaging_items")
      .select("id")
      .eq("owner_id", user.id)
      .like("name", `${prefix}%`);
    const shopPackIds = (shopPacks ?? []).map((p) => String((p as Record<string, unknown>).id));
    if (shopPackIds.length > 0) {
      await supabase.from("packaging_purchases").delete().in("packaging_item_id", shopPackIds);
      await supabase.from("packaging_items").delete().in("id", shopPackIds);
    }

    // 4. Delete expenses & sales of this shop
    await supabase
      .from("expenses")
      .delete()
      .eq("owner_id", user.id)
      .like("description", `${prefix}%`);
    await supabase
      .from("sales")
      .delete()
      .eq("owner_id", user.id)
      .like("notes", `${prefix}%`);

    // 5. Remove from shops_registry and delete scoped settings
    const nextShops = rawShops.filter((s) => s.id !== targetShopId);
    await supabase.from("settings").upsert(
      {
        owner_id: user.id,
        key: SHOPS_REGISTRY_SETTINGS_KEY,
        value: { shops: nextShops },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,key" },
    );

    await supabase
      .from("settings")
      .delete()
      .eq("owner_id", user.id)
      .in("key", [
        scopedSettingsKey("profile", targetShopId),
        scopedSettingsKey("sales", targetShopId),
        scopedSettingsKey("price_presets", targetShopId),
      ]);

    if (currentActiveShopId === targetShopId) {
      const cookieStore = await cookies();
      cookieStore.set(ACTIVE_SHOP_COOKIE, DEFAULT_SHOP_ID, {
        path: "/",
        maxAge: 365 * 24 * 60 * 60,
        sameSite: "lax",
      });
    }

    invalidateQueryCache();
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: `ลบร้าน “${targetShop.shopName}” เรียบร้อยแล้ว`,
    };
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
    const forceAll = form ? form.get("force_all") === "true" || form.get("force_all") === "1" : true;
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
      message:
        res.updatedItemsCount > 0 || res.affectedSalesCount > 0
          ? `คำนวณต้นทุนย้อนหลังให้ออเดอร์เก่า ${res.affectedSalesCount} รายการ (${res.updatedItemsCount} รายการสินค้า) เรียบร้อยแล้ว`
          : "ข้อมูลต้นทุนของออเดอร์ทั้งหมดตรงกับสูตรปัจจุบันแล้ว",
    };
  });
}
