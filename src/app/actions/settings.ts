"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ActionState } from "@/lib/action-state";
import { weightedPricePerUnit } from "@/lib/analytics";
import { readCostRows } from "@/lib/cost-rows";
import { DEFAULT_DELIVERY_FEE_OPTIONS_SATANG, invalidateQueryCache } from "@/lib/data/queries";
import { DEFAULT_UNIT_LABEL } from "@/lib/data/types";
import { bahtToSatang } from "@/lib/money";
import { InputError, dbError, money, optionalText, runAction, text } from "@/lib/server-action";
import { syncHistoricalCosts } from "@/lib/historical-cost-sync";
import { recalculateMenuCosts } from "@/lib/menu-cost";
import {
  ACTIVE_SHOP_COOKIE,
  DEFAULT_SHOP_ID,
  SHOPS_REGISTRY_SETTINGS_KEY,
  type ShopSummary,
  encodeShopText,
  matchesShopText,
  normalizeShopId,
  resolveInventoryShopId,
  scopedSettingsKey,
  shopPrefix,
  stripShopPrefix,
} from "@/lib/shop-scope";

const roundCost = (value: number) => (Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0);

function normalizedCatalogName(value: unknown) {
  return stripShopPrefix(String(value ?? ""))
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("th-TH");
}

function normalizedUnit(value: unknown) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("th-TH");
}

function literalPrefixLike(prefix: string) {
  return `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function isMissingRpcError(error: { code?: string; message?: string } | null | undefined, rpcName: string): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  const msg = String(error.message ?? "");
  return msg.includes(rpcName) && (msg.includes("schema cache") || msg.includes("does not exist"));
}

async function writeShopsRegistry(
  supabase: SupabaseClient,
  ownerId: string,
  expectedShops: ShopSummary[],
  nextShops: ShopSummary[],
  updatedAt: string,
) {
  const rpc = (supabase as unknown as {
    rpc?: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
  }).rpc;
  if (typeof rpc === "function") {
    const { data, error } = await rpc.call(supabase, "compare_and_set_shops_registry", {
      p_expected_shops: expectedShops,
      p_next_shops: nextShops,
      p_updated_at: updatedAt,
    });
    if (!error) {
      if (data !== true) {
        throw new InputError("ข้อมูลร้านถูกแก้ไขจากอีกหน้าต่าง กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง");
      }
      return;
    }
    if (!isMissingRpcError(error, "compare_and_set_shops_registry")) {
      dbError(error);
    }
  }

  // Fallback when compare_and_set_shops_registry RPC is not yet in PostgREST schema cache / DB, or in test doubles.
  const { error } = await supabase.from("settings").upsert(
    {
      owner_id: ownerId,
      key: SHOPS_REGISTRY_SETTINGS_KEY,
      value: { shops: nextShops },
      updated_at: updatedAt,
    },
    { onConflict: "owner_id,key" },
  );
  if (error) dbError(error);
}

async function executeRollbackActions(actions: Array<() => Promise<unknown>>) {
  let pending = [...actions].reverse();
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
    const failed: Array<() => Promise<unknown>> = [];
    for (const undo of pending) {
      try {
        const result = await undo();
        const rollbackError =
          result && typeof result === "object" && "error" in result
            ? (result as { error?: unknown }).error
            : null;
        if (rollbackError) failed.push(undo);
      } catch {
        failed.push(undo);
      }
    }
    pending = failed;
  }
  if (pending.length > 0) {
    throw new Error(`rollback failed for ${pending.length} operation(s)`);
  }
}

function assertIngredientCatalogCompatible(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
) {
  const conflicts: string[] = [];
  if (String(source.costing ?? "per_unit") !== String(target.costing ?? "per_unit")) conflicts.push("วิธีคิดต้นทุน");
  if (normalizedUnit(source.base_unit) !== normalizedUnit(target.base_unit)) conflicts.push("หน่วยฐาน");
  if (normalizedUnit(source.purchase_unit) !== normalizedUnit(target.purchase_unit)) conflicts.push("หน่วยซื้อ");
  if (Math.abs(Number(source.units_per_purchase_unit ?? 1) - Number(target.units_per_purchase_unit ?? 1)) > 0.000001) {
    conflicts.push("จำนวนต่อหน่วยซื้อ");
  }
  if (conflicts.length > 0) {
    throw new InputError(
      `วัตถุดิบ “${stripShopPrefix(String(source.name ?? ""))}” ชื่อซ้ำกันแต่ ${conflicts.join(", ")} ไม่ตรงกัน กรุณาเปลี่ยนชื่อหรือปรับหน่วยให้ตรงก่อนเชื่อมคลัง`,
    );
  }
}

function assertPackagingCatalogCompatible(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
) {
  const conflicts: string[] = [];
  if (normalizedUnit(source.unit) !== normalizedUnit(target.unit)) conflicts.push("หน่วยนับ");
  if (Boolean(source.per_order) !== Boolean(target.per_order)) conflicts.push("การคิดต่อออเดอร์");
  if (conflicts.length > 0) {
    throw new InputError(
      `บรรจุภัณฑ์ “${stripShopPrefix(String(source.name ?? ""))}” ชื่อซ้ำกันแต่ ${conflicts.join(", ")} ไม่ตรงกัน กรุณาเปลี่ยนชื่อหรือปรับข้อมูลให้ตรงก่อนเชื่อมคลัง`,
    );
  }
}

async function insertIngredientWithFallback(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<string | null> {
  let { data, error } = await supabase.from("ingredients").insert(payload).select("id").single();
  if (error && error.code === "22P02" && error.message.includes("bigint")) {
    const fallback = await supabase
      .from("ingredients")
      .insert({
        ...payload,
        price_per_purchase_unit_satang: Math.round(Number(payload.price_per_purchase_unit_satang ?? 0)),
        weighted_unit_cost_satang: Math.round(Number(payload.weighted_unit_cost_satang ?? 0)),
      })
      .select("id")
      .single();
    data = fallback.data;
    error = fallback.error;
  }
  if (error) dbError(error);
  return data ? String((data as Record<string, unknown>).id) : null;
}

async function insertPackagingWithFallback(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<string | null> {
  let { data, error } = await supabase.from("packaging_items").insert(payload).select("id").single();
  if (error && error.code === "22P02" && error.message.includes("bigint")) {
    const fallback = await supabase
      .from("packaging_items")
      .insert({
        ...payload,
        unit_cost_satang: Math.round(Number(payload.unit_cost_satang ?? 0)),
      })
      .select("id")
      .single();
    data = fallback.data;
    error = fallback.error;
  }
  if (error) dbError(error);
  return data ? String((data as Record<string, unknown>).id) : null;
}

async function updateIngredientCostWithFallback(
  supabase: SupabaseClient,
  id: string,
  pricePerPurchaseUnitSatang: number,
  weightedUnitCostSatang: number,
) {
  let { error } = await supabase
    .from("ingredients")
    .update({
      price_per_purchase_unit_satang: roundCost(pricePerPurchaseUnitSatang),
      weighted_unit_cost_satang: roundCost(weightedUnitCostSatang),
    })
    .eq("id", id);
  if (error && error.code === "22P02" && error.message.includes("bigint")) {
    const fallback = await supabase
      .from("ingredients")
      .update({
        price_per_purchase_unit_satang: Math.round(pricePerPurchaseUnitSatang),
        weighted_unit_cost_satang: Math.round(weightedUnitCostSatang),
      })
      .eq("id", id);
    error = fallback.error;
  }
  if (error) dbError(error);
}

async function updatePackagingCostWithFallback(
  supabase: SupabaseClient,
  id: string,
  unitCostSatang: number,
) {
  let { error } = await supabase
    .from("packaging_items")
    .update({ unit_cost_satang: roundCost(unitCostSatang) })
    .eq("id", id);
  if (error && error.code === "22P02" && error.message.includes("bigint")) {
    const fallback = await supabase
      .from("packaging_items")
      .update({ unit_cost_satang: Math.round(unitCostSatang) })
      .eq("id", id);
    error = fallback.error;
  }
  if (error) dbError(error);
}

async function recomputeCatalogItemCosts(
  supabase: SupabaseClient,
  ownerId: string,
  ingredientIds: Iterable<string>,
  packagingIds: Iterable<string>,
  options?: {
    fallbackIngPrices?: Map<string, { pricePerPurchase: number; weightedUnit: number }>;
    fallbackPackCosts?: Map<string, number>;
    resetWhenEmpty?: boolean;
  },
) {
  const ingList = Array.from(new Set(ingredientIds)).filter(Boolean);
  const packList = Array.from(new Set(packagingIds)).filter(Boolean);

  if (ingList.length > 0) {
    const { data: ingRows, error: ingErr } = await supabase
      .from("ingredients")
      .select("id,costing,units_per_purchase_unit,weighted_unit_cost_satang")
      .in("id", ingList);
    if (ingErr) dbError(ingErr);
    for (const ing of (ingRows ?? []) as Array<Record<string, unknown>>) {
      if (String(ing.costing ?? "per_unit") !== "per_unit") continue;
      const ingId = String(ing.id);
      const purRows = await readCostRows((from, to) =>
        supabase
          .from("ingredient_purchases")
          .select("id,purchased_at,price_satang,purchased_quantity")
          .eq("ingredient_id", ingId)
          .order("id")
          .range(from, to),
      );
      if (purRows && purRows.length > 0) {
        const mapped = (purRows as Array<{ purchased_at: unknown; price_satang: unknown; purchased_quantity: unknown }>).map(
          (p) => ({
            purchasedAt: String(p.purchased_at),
            price: Number(p.price_satang),
            quantity: p.purchased_quantity === null ? null : Number(p.purchased_quantity),
          }),
        );
        const weighted = weightedPricePerUnit(mapped);
        const unitsPer = Math.max(0.0001, Number(ing.units_per_purchase_unit ?? 1));
        await updateIngredientCostWithFallback(supabase, ingId, weighted, weighted / unitsPer);
      } else if (options?.fallbackIngPrices?.has(ingId)) {
        const fb = options.fallbackIngPrices.get(ingId)!;
        await updateIngredientCostWithFallback(supabase, ingId, fb.pricePerPurchase, fb.weightedUnit);
      } else if (options?.resetWhenEmpty) {
        await updateIngredientCostWithFallback(supabase, ingId, 0, 0);
      }
    }
  }

  if (packList.length > 0) {
    const [{ data: packRows, error: packErr }, { data: defRow }] = await Promise.all([
      supabase.from("packaging_items").select("id,unit_cost_satang").in("id", packList),
      supabase
        .from("settings")
        .select("value")
        .eq("owner_id", ownerId)
        .eq("key", "packaging_defaults")
        .maybeSingle(),
    ]);
    if (packErr) dbError(packErr);
    const packDefaults = ((defRow?.value ?? {}) as Record<
      string,
      { priceSatang?: number; packPriceSatang?: number; packQuantity?: number }
    >);
    for (const pack of (packRows ?? []) as Array<Record<string, unknown>>) {
      const packId = String(pack.id);
      const purRows = await readCostRows((from, to) =>
        supabase
          .from("packaging_purchases")
          .select("id,price_satang,pack_quantity")
          .eq("packaging_item_id", packId)
          .order("id")
          .range(from, to),
      );
      if (purRows && purRows.length > 0) {
        let totalPrice = 0;
        let totalPieces = 0;
        for (const p of purRows as Array<{ price_satang: unknown; pack_quantity: unknown }>) {
          totalPrice += Number(p.price_satang);
          totalPieces += Number(p.pack_quantity);
        }
        if (totalPieces > 0) {
          await updatePackagingCostWithFallback(supabase, packId, totalPrice / totalPieces);
        }
      } else if (options?.fallbackPackCosts?.has(packId)) {
        await updatePackagingCostWithFallback(supabase, packId, options.fallbackPackCosts.get(packId)!);
      } else if (options?.resetWhenEmpty) {
        const def = packDefaults[packId];
        const defPrice = Number(def?.packPriceSatang ?? def?.priceSatang ?? 0);
        const defQty = Number(def?.packQuantity ?? 0);
        const fallbackCost = defPrice > 0 && defQty > 0 ? defPrice / defQty : 0;
        await updatePackagingCostWithFallback(supabase, packId, fallbackCost);
      }
    }
  }
}

async function cleanupFailedShopCreation(
  supabase: SupabaseClient,
  ownerId: string,
  shopId: string,
  originalShops: ShopSummary[],
  expectedShops: ShopSummary[],
) {
  const [{ data: menus }, { data: ingredients }, { data: packaging }, { data: defaultsRow }, { data: yieldsRow }] =
    await Promise.all([
      supabase.from("menus").select("id,name").eq("owner_id", ownerId),
      supabase.from("ingredients").select("id,name").eq("owner_id", ownerId),
      supabase.from("packaging_items").select("id,name").eq("owner_id", ownerId),
      supabase.from("settings").select("value").eq("owner_id", ownerId).eq("key", "packaging_defaults").maybeSingle(),
      supabase.from("settings").select("value").eq("owner_id", ownerId).eq("key", "menu_yields").maybeSingle(),
    ]);
  const menuIds = ((menus ?? []) as Array<Record<string, unknown>>)
    .filter((row) => matchesShopText(String(row.name ?? ""), shopId))
    .map((row) => String(row.id));
  const ingredientIds = ((ingredients ?? []) as Array<Record<string, unknown>>)
    .filter((row) => matchesShopText(String(row.name ?? ""), shopId))
    .map((row) => String(row.id));
  const packagingIds = ((packaging ?? []) as Array<Record<string, unknown>>)
    .filter((row) => matchesShopText(String(row.name ?? ""), shopId))
    .map((row) => String(row.id));

  if (menuIds.length > 0) {
    await supabase.from("menu_recipe_items").delete().in("menu_id", menuIds);
    await supabase.from("menus").delete().in("id", menuIds);
  }
  if (ingredientIds.length > 0) {
    await supabase.from("menu_recipe_items").delete().in("ingredient_id", ingredientIds);
    await supabase.from("ingredients").delete().in("id", ingredientIds);
  }
  if (packagingIds.length > 0) {
    await supabase.from("menu_recipe_items").delete().in("packaging_item_id", packagingIds);
    await supabase.from("packaging_items").delete().in("id", packagingIds);
  }

  const defaults = { ...((defaultsRow?.value ?? {}) as Record<string, unknown>) };
  let defaultsChanged = false;
  for (const itemId of packagingIds) {
    if (itemId in defaults) {
      delete defaults[itemId];
      defaultsChanged = true;
    }
  }
  if (defaultsChanged) {
    await supabase.from("settings").upsert(
      { owner_id: ownerId, key: "packaging_defaults", value: defaults, updated_at: new Date().toISOString() },
      { onConflict: "owner_id,key" },
    );
  }

  const yields = { ...((yieldsRow?.value ?? {}) as Record<string, unknown>) };
  let yieldsChanged = false;
  for (const menuId of menuIds) {
    if (menuId in yields) {
      delete yields[menuId];
      yieldsChanged = true;
    }
  }
  if (yieldsChanged) {
    await supabase.from("settings").upsert(
      { owner_id: ownerId, key: "menu_yields", value: yields, updated_at: new Date().toISOString() },
      { onConflict: "owner_id,key" },
    );
  }

  await supabase
    .from("settings")
    .delete()
    .eq("owner_id", ownerId)
    .in("key", [
      scopedSettingsKey("profile", shopId),
      scopedSettingsKey("sales", shopId),
      scopedSettingsKey("price_presets", shopId),
    ]);
  await writeShopsRegistry(supabase, ownerId, expectedShops, originalShops, new Date().toISOString());
}

async function restoreCatalogCostSnapshots(
  supabase: SupabaseClient,
  ingredients: Array<Record<string, unknown>>,
  packaging: Array<Record<string, unknown>>,
) {
  for (const ingredient of ingredients) {
    await updateIngredientCostWithFallback(
      supabase,
      String(ingredient.id),
      Number(ingredient.price_per_purchase_unit_satang ?? 0),
      Number(ingredient.weighted_unit_cost_satang ?? 0),
    );
  }
  for (const item of packaging) {
    await updatePackagingCostWithFallback(
      supabase,
      String(item.id),
      Number(item.unit_cost_satang ?? 0),
    );
  }
  await recalculateMenuCosts(supabase);
}

function menuImageStoragePath(imagePath: unknown) {
  const value = String(imagePath ?? "");
  const marker = "/storage/v1/object/public/menu-images/";
  const index = value.indexOf(marker);
  if (index < 0) return null;
  try {
    return decodeURIComponent(value.slice(index + marker.length));
  } catch {
    return value.slice(index + marker.length);
  }
}

async function cleanupUnreferencedShopFiles(
  supabase: SupabaseClient,
  receiptPaths: string[],
  slipPaths: string[],
  menuImageUrls: string[],
) {
  const saleSlipPaths = Array.from(new Set([...receiptPaths, ...slipPaths].filter(Boolean)));
  const removableSaleSlips: string[] = [];
  for (const path of saleSlipPaths) {
    const [{ count: expenseCount }, { count: slipCount }] = await Promise.all([
      supabase.from("expenses").select("id", { count: "exact", head: true }).eq("receipt_path", path),
      supabase.from("slip_uploads").select("id", { count: "exact", head: true }).eq("storage_path", path),
    ]);
    if ((expenseCount ?? 0) === 0 && (slipCount ?? 0) === 0) removableSaleSlips.push(path);
  }
  if (removableSaleSlips.length > 0) {
    await supabase.storage.from("sale-slips").remove(removableSaleSlips).catch(() => undefined);
  }

  const removableMenuImages: string[] = [];
  for (const imageUrl of Array.from(new Set(menuImageUrls.filter(Boolean)))) {
    const storagePath = menuImageStoragePath(imageUrl);
    if (!storagePath) continue;
    const { count } = await supabase
      .from("menus")
      .select("id", { count: "exact", head: true })
      .eq("image_path", imageUrl);
    if ((count ?? 0) === 0) removableMenuImages.push(storagePath);
  }
  if (removableMenuImages.length > 0) {
    await supabase.storage.from("menu-images").remove(removableMenuImages).catch(() => undefined);
  }
}

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
      const { data: regRow, error: regReadError } = await supabase
        .from("settings")
        .select("value")
        .eq("owner_id", user.id)
        .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
        .maybeSingle();
      if (regReadError) dbError(regReadError);
      const rawShops = ((regRow?.value as { shops?: ShopSummary[] } | null)?.shops ?? []) as ShopSummary[];
      const nextShops = rawShops.map((s) => (s.id === shopId ? { ...s, unitLabel } : s));
      await writeShopsRegistry(supabase, user.id, rawShops, nextShops, new Date().toISOString());
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
      const { data: regRow, error: regReadError } = await supabase
        .from("settings")
        .select("value")
        .eq("owner_id", user.id)
        .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
        .maybeSingle();
      if (regReadError) dbError(regReadError);
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
      await writeShopsRegistry(supabase, user.id, rawShops, nextShops, new Date().toISOString());
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
      const { data: regRow, error: regReadError } = await supabase
        .from("settings")
        .select("value")
        .eq("owner_id", user.id)
        .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
        .maybeSingle();
      if (regReadError) dbError(regReadError);
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
    const shareMode = String(form.get("share_ingredients_mode") ?? "").trim();
    const rawShareFrom = String(form.get("share_ingredients_from") ?? "").trim();
    const copyIngredients = form.get("copy_ingredients") === "on" || form.get("copy_ingredients") === "true";
    const copyMenus = form.get("copy_menus") === "on" || form.get("copy_menus") === "true";

    const [
      { data: regRow, error: regReadError },
      { data: primaryProfile, error: primaryProfileError },
      { data: primaryProfileSetting, error: primaryProfileSettingError },
    ] = await Promise.all([
      supabase
        .from("settings")
        .select("value")
        .eq("owner_id", user.id)
        .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
        .maybeSingle(),
      supabase.from("profiles").select("shop_name").eq("id", user.id).maybeSingle(),
      supabase
        .from("settings")
        .select("value")
        .eq("owner_id", user.id)
        .eq("key", "profile")
        .maybeSingle(),
    ]);
    if (regReadError) dbError(regReadError);
    if (primaryProfileError) dbError(primaryProfileError);
    if (primaryProfileSettingError) dbError(primaryProfileSettingError);
    const rawShops = ((regRow?.value as { shops?: ShopSummary[] } | null)?.shops ?? []) as ShopSummary[];

    const normalizedNewShopName = normalizedCatalogName(shopName);
    const defaultShopNames = [
      primaryProfile?.shop_name,
      (primaryProfileSetting?.value as Record<string, unknown> | null)?.shop_name,
      (user.user_metadata as Record<string, unknown> | null)?.shop_name,
    ].filter((value) => normalizedCatalogName(value));
    if (
      defaultShopNames.some((value) => normalizedCatalogName(value) === normalizedNewShopName) ||
      rawShops.some((s) => normalizedCatalogName(s.shopName) === normalizedNewShopName)
    ) {
      throw new InputError(`มีร้านชื่อ “${shopName}” อยู่แล้ว`);
    }

    const sourceInventoryShopId = resolveInventoryShopId(sourceShopId, rawShops);
    let sharedIngredientsFromShopId: string | null = null;
    if (shareMode !== "isolated" && rawShareFrom !== "isolated" && (shareMode === "shared" || rawShareFrom !== "")) {
      const candidateTarget = normalizeShopId(rawShareFrom || sourceShopId);
      const validTarget =
        candidateTarget === DEFAULT_SHOP_ID || rawShops.some((s) => s.id === candidateTarget);
      if (validTarget) {
        sharedIngredientsFromShopId = resolveInventoryShopId(candidateTarget, rawShops);
      }
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
      sharedIngredientsFromShopId,
    };

    try {
    // 1. Save initial profile & sales settings for the new shop. The registry is
    // written last so a failed clone never exposes a partially-created shop.
    const { data: sourceSalesSetting, error: sourceSalesError } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", scopedSettingsKey("sales", sourceShopId))
      .maybeSingle();
    if (sourceSalesError) dbError(sourceSalesError);
    const srcSales = (sourceSalesSetting?.value ?? {}) as Record<string, unknown>;

    const { error: initialSettingsError } = await supabase.from("settings").upsert(
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
    if (initialSettingsError) dbError(initialSettingsError);

    // 3. Handle ingredients & packaging (either shared live OR cloned if isolated)
    const ingIdMap = new Map<string, string>();
    const packIdMap = new Map<string, string>();

    if (sharedIngredientsFromShopId) {
      // Live shared catalog: no duplicate rows created!
      // If copying menus too, map source catalog IDs to the shared catalog IDs.
      if (copyMenus) {
        const [{ data: ingRows, error: ingRowsError }, { data: packRows, error: packRowsError }] = await Promise.all([
          supabase.from("ingredients").select("id,name,costing,base_unit,purchase_unit,units_per_purchase_unit").eq("owner_id", user.id),
          supabase.from("packaging_items").select("id,name,unit,per_order").eq("owner_id", user.id),
        ]);
        if (ingRowsError) dbError(ingRowsError);
        if (packRowsError) dbError(packRowsError);
        const allIngs = (ingRows ?? []) as Array<Record<string, unknown>>;
        const allPacks = (packRows ?? []) as Array<Record<string, unknown>>;

        if (sharedIngredientsFromShopId === sourceInventoryShopId) {
          for (const ing of allIngs) {
            if (matchesShopText(String(ing.name ?? ""), sourceInventoryShopId)) {
              const idStr = String(ing.id);
              ingIdMap.set(idStr, idStr);
            }
          }
          for (const pack of allPacks) {
            if (matchesShopText(String(pack.name ?? ""), sourceInventoryShopId)) {
              const idStr = String(pack.id);
              packIdMap.set(idStr, idStr);
            }
          }
        } else {
          const targetIngByName = new Map<string, Record<string, unknown>>();
          for (const ing of allIngs) {
            if (matchesShopText(String(ing.name ?? ""), sharedIngredientsFromShopId)) {
              targetIngByName.set(normalizedCatalogName(ing.name), ing);
            }
          }
          for (const ing of allIngs) {
            if (matchesShopText(String(ing.name ?? ""), sourceInventoryShopId)) {
              const matched = targetIngByName.get(normalizedCatalogName(ing.name));
              if (matched) {
                assertIngredientCatalogCompatible(ing, matched);
                ingIdMap.set(String(ing.id), String(matched.id));
              }
            }
          }

          const targetPackByName = new Map<string, Record<string, unknown>>();
          for (const pack of allPacks) {
            if (matchesShopText(String(pack.name ?? ""), sharedIngredientsFromShopId)) {
              targetPackByName.set(normalizedCatalogName(pack.name), pack);
            }
          }
          for (const pack of allPacks) {
            if (matchesShopText(String(pack.name ?? ""), sourceInventoryShopId)) {
              const matched = targetPackByName.get(normalizedCatalogName(pack.name));
              if (matched) {
                assertPackagingCatalogCompatible(pack, matched);
                packIdMap.set(String(pack.id), String(matched.id));
              }
            }
          }
        }
      }
    } else if (copyIngredients || copyMenus) {
      const [
        { data: ingRows, error: ingRowsError },
        { data: packRows, error: packRowsError },
        { data: packDefaultsRow, error: packDefaultsError },
      ] = await Promise.all([
        supabase
          .from("ingredients")
          .select("id,name,category,costing,base_unit,purchase_unit,units_per_purchase_unit,price_per_purchase_unit_satang,weighted_unit_cost_satang,yield_auto,yield_updated_at,is_active")
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
      if (ingRowsError) dbError(ingRowsError);
      if (packRowsError) dbError(packRowsError);
      if (packDefaultsError) dbError(packDefaultsError);

      const sourceIngredients = (ingRows ?? []).filter((r) =>
        matchesShopText(String((r as Record<string, unknown>).name ?? ""), sourceInventoryShopId),
      );
      for (const ing of sourceIngredients as Array<Record<string, unknown>>) {
        const cleanName = stripShopPrefix(String(ing.name ?? ""));
        const newIngId = await insertIngredientWithFallback(supabase, {
          owner_id: user.id,
          name: encodeShopText(cleanName, newShopId),
          category: ing.category,
          costing: ing.costing,
          base_unit: ing.base_unit,
          purchase_unit: ing.purchase_unit,
          units_per_purchase_unit: ing.units_per_purchase_unit,
          price_per_purchase_unit_satang: ing.price_per_purchase_unit_satang,
          weighted_unit_cost_satang: ing.weighted_unit_cost_satang,
          yield_auto: ing.yield_auto,
          yield_updated_at: ing.yield_updated_at,
          is_active: ing.is_active,
        });
        if (newIngId) {
          ingIdMap.set(String(ing.id), newIngId);
        }
      }

      const sourcePackagings = (packRows ?? []).filter((r) =>
        matchesShopText(String((r as Record<string, unknown>).name ?? ""), sourceInventoryShopId),
      );
      const packDefaultsMap: Record<string, unknown> = {
        ...((packDefaultsRow?.value ?? {}) as Record<string, unknown>),
      };
      let packDefaultsChanged = false;

      for (const pack of sourcePackagings as Array<Record<string, unknown>>) {
        const cleanName = stripShopPrefix(String(pack.name ?? ""));
        const newId = await insertPackagingWithFallback(supabase, {
          owner_id: user.id,
          name: encodeShopText(cleanName, newShopId),
          unit: pack.unit,
          per_order: pack.per_order,
          unit_cost_satang: pack.unit_cost_satang,
          is_active: pack.is_active,
        });
        if (newId) {
          const oldId = String(pack.id);
          packIdMap.set(oldId, newId);
          if (packDefaultsMap[oldId]) {
            packDefaultsMap[newId] = packDefaultsMap[oldId];
            packDefaultsChanged = true;
          }
        }
      }

      if (packDefaultsChanged) {
        const { error: defaultsUpsertError } = await supabase.from("settings").upsert(
          {
            owner_id: user.id,
            key: "packaging_defaults",
            value: packDefaultsMap,
            updated_at: nowIso,
          },
          { onConflict: "owner_id,key" },
        );
        if (defaultsUpsertError) dbError(defaultsUpsertError);
      }
    }

    // 4. Optionally clone menus & recipes from current shop
    if (copyMenus) {
      const [
        { data: menuRows, error: menuRowsError },
        { data: menuYieldsRow, error: menuYieldsError },
      ] = await Promise.all([
        supabase
          .from("menus")
          .select("id,name,category,image_path,selling_price_satang,packaging_cost_satang,current_cost_satang,is_available,cost_calculated_at")
          .eq("owner_id", user.id),
        supabase
          .from("settings")
          .select("value")
          .eq("owner_id", user.id)
          .eq("key", "menu_yields")
          .maybeSingle(),
      ]);
      if (menuRowsError) dbError(menuRowsError);
      if (menuYieldsError) dbError(menuYieldsError);

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
        const { data: insertedMenu, error: insertedMenuError } = await supabase
          .from("menus")
          .insert({
            owner_id: user.id,
            name: encodeShopText(cleanName, newShopId),
            category: m.category,
            image_path: m.image_path,
            selling_price_satang: m.selling_price_satang,
            packaging_cost_satang: m.packaging_cost_satang,
            current_cost_satang: m.current_cost_satang,
            is_available: m.is_available,
            cost_calculated_at: m.cost_calculated_at,
          })
          .select("id")
          .single();
        if (insertedMenuError) dbError(insertedMenuError);
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
        const { error: yieldsUpsertError } = await supabase.from("settings").upsert(
          {
            owner_id: user.id,
            key: "menu_yields",
            value: yieldsMap,
            updated_at: nowIso,
          },
          { onConflict: "owner_id,key" },
        );
        if (yieldsUpsertError) dbError(yieldsUpsertError);
      }

      if (menuIdMap.size > 0) {
        const { data: recipeRows, error: recipeRowsError } = await supabase
          .from("menu_recipe_items")
          .select("menu_id,ingredient_id,packaging_item_id,quantity")
          .in("menu_id", Array.from(menuIdMap.keys()));
        if (recipeRowsError) dbError(recipeRowsError);

        const recipesToInsert: Array<Record<string, unknown>> = [];
        for (const r of (recipeRows ?? []) as Array<Record<string, unknown>>) {
          const newMenuId = menuIdMap.get(String(r.menu_id));
          if (!newMenuId) continue;
          if (r.ingredient_id) {
            const newIngId = ingIdMap.get(String(r.ingredient_id));
            if (!newIngId) {
              throw new InputError("คัดลอกเมนูไม่ได้ เพราะมีวัตถุดิบในสูตรที่ไม่มีรายการตรงกันในคลังเป้าหมาย");
            }
            recipesToInsert.push({
              owner_id: user.id,
              menu_id: newMenuId,
              ingredient_id: newIngId,
              packaging_item_id: null,
              quantity: r.quantity,
            });
          } else if (r.packaging_item_id) {
            const newPackId = packIdMap.get(String(r.packaging_item_id));
            if (!newPackId) {
              throw new InputError("คัดลอกเมนูไม่ได้ เพราะมีบรรจุภัณฑ์ในสูตรที่ไม่มีรายการตรงกันในคลังเป้าหมาย");
            }
            recipesToInsert.push({
              owner_id: user.id,
              menu_id: newMenuId,
              ingredient_id: null,
              packaging_item_id: newPackId,
              quantity: r.quantity,
            });
          }
        }

        if (recipesToInsert.length > 0) {
          const { error: recipeInsertError } = await supabase.from("menu_recipe_items").insert(recipesToInsert);
          if (recipeInsertError) dbError(recipeInsertError);
        }
        await recalculateMenuCosts(supabase, Array.from(menuIdMap.values()));
      }
    }

    // 5. Publish the new shop only after every dependent row is ready.
    await writeShopsRegistry(supabase, user.id, rawShops, [...rawShops, newShopEntry], nowIso);

    // 6. Switch active shop cookie to the newly created shop
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
    } catch (error) {
      await cleanupFailedShopCreation(
        supabase,
        user.id,
        newShopId,
        rawShops,
        [...rawShops, newShopEntry],
      ).catch(() => undefined);
      throw error;
    }
  });
}

export async function updateShopIngredientSharingAction(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId: currentActiveShopId }) => {
    const targetShopId = normalizeShopId(String(form.get("shop_id") ?? currentActiveShopId));
    if (!targetShopId || targetShopId === DEFAULT_SHOP_ID) {
      throw new InputError("ร้านหลักเป็นคลังวัตถุดิบหลักอยู่แล้ว สามารถตั้งค่าการเชื่อมคลังได้ที่ร้านสาขา");
    }

    const rawLinkTo = String(form.get("shared_from_shop_id") ?? "").trim();
    const { data: regRow, error: regReadError } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
      .maybeSingle();
    if (regReadError) dbError(regReadError);
    const rawShops = ((regRow?.value as { shops?: ShopSummary[] } | null)?.shops ?? []) as ShopSummary[];
    const shopEntry = rawShops.find((s) => s.id === targetShopId);
    if (!shopEntry) {
      throw new InputError("ไม่พบร้านที่ต้องการตั้งค่า");
    }

    const currentInvShopId = resolveInventoryShopId(targetShopId, rawShops);
    const nowIso = new Date().toISOString();

    // Case 1: Unlink -> isolate catalog into targetShopId
    if (!rawLinkTo || rawLinkTo === "isolated" || rawLinkTo === targetShopId) {
      if (currentInvShopId === targetShopId) {
        return { ok: true, message: `ร้าน “${shopEntry.shopName}” แยกคลังวัตถุดิบอิสระอยู่แล้ว` };
      }

      const [
        { data: ingRows, error: ingReadErr },
        { data: packRows, error: packReadErr },
        { data: packDefaultsRow, error: defReadErr },
        { data: menuRows, error: menuReadErr },
      ] = await Promise.all([
        supabase
          .from("ingredients")
          .select("id,name,category,costing,base_unit,purchase_unit,units_per_purchase_unit,price_per_purchase_unit_satang,weighted_unit_cost_satang,yield_auto,yield_updated_at,is_active")
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
        supabase.from("menus").select("id,name").eq("owner_id", user.id),
      ]);
      if (ingReadErr) dbError(ingReadErr);
      if (packReadErr) dbError(packReadErr);
      if (defReadErr) dbError(defReadErr);
      if (menuReadErr) dbError(menuReadErr);

      const allIngs = (ingRows ?? []) as Array<Record<string, unknown>>;
      const allPacks = (packRows ?? []) as Array<Record<string, unknown>>;
      const allIngById = new Map(allIngs.map((row) => [String(row.id), row]));
      const allPackById = new Map(allPacks.map((row) => [String(row.id), row]));
      const costSnapshotIngredients = allIngs.filter((row) =>
        [currentInvShopId, targetShopId].some((shopId) => matchesShopText(String(row.name ?? ""), shopId)),
      );
      const costSnapshotPackaging = allPacks.filter((row) =>
        [currentInvShopId, targetShopId].some((shopId) => matchesShopText(String(row.name ?? ""), shopId)),
      );
      const sourceIngs = allIngs.filter((r) => matchesShopText(String(r.name ?? ""), currentInvShopId));
      const existingOwnIngByName = new Map<string, string>();
      for (const r of allIngs) {
        if (matchesShopText(String(r.name ?? ""), targetShopId)) {
          existingOwnIngByName.set(normalizedCatalogName(r.name), String(r.id));
        }
      }

      const rollbackActions: Array<() => Promise<unknown>> = [];
      try {
        const ingIdMap = new Map<string, string>();
        for (const ing of sourceIngs) {
          const cleanName = stripShopPrefix(String(ing.name ?? ""));
          const existingId = existingOwnIngByName.get(normalizedCatalogName(cleanName));
          if (existingId) {
            const existing = allIngById.get(existingId);
            if (existing) assertIngredientCatalogCompatible(ing, existing);
            ingIdMap.set(String(ing.id), existingId);
            continue;
          }
          const insertedIngId = await insertIngredientWithFallback(supabase, {
            owner_id: user.id,
            name: encodeShopText(cleanName, targetShopId),
            category: ing.category,
            costing: ing.costing,
            base_unit: ing.base_unit,
            purchase_unit: ing.purchase_unit,
            units_per_purchase_unit: ing.units_per_purchase_unit,
            price_per_purchase_unit_satang: ing.price_per_purchase_unit_satang,
            weighted_unit_cost_satang: ing.weighted_unit_cost_satang,
            yield_auto: ing.yield_auto,
            yield_updated_at: ing.yield_updated_at,
            is_active: ing.is_active,
          });
          if (insertedIngId) {
            ingIdMap.set(String(ing.id), insertedIngId);
            rollbackActions.push(async () =>
              supabase.from("ingredients").delete().eq("id", insertedIngId),
            );
          }
        }

        const sourcePacks = allPacks.filter((r) => matchesShopText(String(r.name ?? ""), currentInvShopId));
        const existingOwnPackByName = new Map<string, string>();
        for (const r of allPacks) {
          if (matchesShopText(String(r.name ?? ""), targetShopId)) {
            existingOwnPackByName.set(normalizedCatalogName(r.name), String(r.id));
          }
        }

        const originalPackDefaults = { ...((packDefaultsRow?.value ?? {}) as Record<string, unknown>) };
        const packDefaultsMap: Record<string, unknown> = { ...originalPackDefaults };
        let packDefaultsChanged = false;
        const packIdMap = new Map<string, string>();

        for (const pack of sourcePacks) {
          const cleanName = stripShopPrefix(String(pack.name ?? ""));
          const oldId = String(pack.id);
          const existingId = existingOwnPackByName.get(normalizedCatalogName(cleanName));
          if (existingId) {
            const existing = allPackById.get(existingId);
            if (existing) assertPackagingCatalogCompatible(pack, existing);
            packIdMap.set(oldId, existingId);
            continue;
          }
          const newId = await insertPackagingWithFallback(supabase, {
            owner_id: user.id,
            name: encodeShopText(cleanName, targetShopId),
            unit: pack.unit,
            per_order: pack.per_order,
            unit_cost_satang: pack.unit_cost_satang,
            is_active: pack.is_active,
          });
          if (newId) {
            packIdMap.set(oldId, newId);
            rollbackActions.push(async () =>
              supabase.from("packaging_items").delete().eq("id", newId),
            );
            if (packDefaultsMap[oldId]) {
              packDefaultsMap[newId] = packDefaultsMap[oldId];
              packDefaultsChanged = true;
            }
          }
        }

        if (packDefaultsChanged) {
          const { error: defUpsertErr } = await supabase.from("settings").upsert(
            {
              owner_id: user.id,
              key: "packaging_defaults",
              value: packDefaultsMap,
              updated_at: nowIso,
            },
            { onConflict: "owner_id,key" },
          );
          if (defUpsertErr) dbError(defUpsertErr);
          rollbackActions.push(async () =>
            supabase.from("settings").upsert(
              {
                owner_id: user.id,
                key: "packaging_defaults",
                value: originalPackDefaults,
                updated_at: nowIso,
              },
              { onConflict: "owner_id,key" },
            ),
          );
        }

        const targetPrefix = shopPrefix(targetShopId);
        const affectedIngIdsForCost = new Set<string>();
        const affectedPackIdsForCost = new Set<string>();
        const sourceIngIdsForReset = new Set<string>();
        const sourcePackIdsForReset = new Set<string>();
        if (targetPrefix) {
          for (const [oldIngId, newIngId] of ingIdMap.entries()) {
            if (oldIngId !== newIngId) {
              const { error: purMoveErr } = await supabase
                .from("ingredient_purchases")
                .update({ ingredient_id: newIngId })
                .eq("ingredient_id", oldIngId)
                .like("vendor", literalPrefixLike(targetPrefix));
              if (purMoveErr) dbError(purMoveErr);
              affectedIngIdsForCost.add(oldIngId);
              affectedIngIdsForCost.add(newIngId);
              sourceIngIdsForReset.add(oldIngId);
              rollbackActions.push(async () =>
                supabase
                  .from("ingredient_purchases")
                  .update({ ingredient_id: oldIngId })
                  .eq("ingredient_id", newIngId)
                  .like("vendor", literalPrefixLike(targetPrefix)),
              );
            }
          }
          for (const [oldPackId, newPackId] of packIdMap.entries()) {
            if (oldPackId !== newPackId) {
              const { error: packPurMoveErr } = await supabase
                .from("packaging_purchases")
                .update({ packaging_item_id: newPackId })
                .eq("packaging_item_id", oldPackId)
                .like("vendor", literalPrefixLike(targetPrefix));
              if (packPurMoveErr) dbError(packPurMoveErr);
              affectedPackIdsForCost.add(oldPackId);
              affectedPackIdsForCost.add(newPackId);
              sourcePackIdsForReset.add(oldPackId);
              rollbackActions.push(async () =>
                supabase
                  .from("packaging_purchases")
                  .update({ packaging_item_id: oldPackId })
                  .eq("packaging_item_id", newPackId)
                  .like("vendor", literalPrefixLike(targetPrefix)),
              );
            }
          }
          const { data: targetSaleRows, error: saleReadErr } = await supabase
            .from("sales")
            .select("id")
            .eq("owner_id", user.id)
            .like("notes", literalPrefixLike(targetPrefix));
          if (saleReadErr) dbError(saleReadErr);
          const targetSaleIds = (targetSaleRows ?? []).map((s) => String((s as Record<string, unknown>).id));
          if (targetSaleIds.length > 0) {
            for (const [oldPackId, newPackId] of packIdMap.entries()) {
              if (oldPackId !== newPackId) {
                const { error: spErr } = await supabase
                  .from("sale_packaging")
                  .update({ packaging_item_id: newPackId })
                  .in("sale_id", targetSaleIds)
                  .eq("packaging_item_id", oldPackId);
                if (spErr) dbError(spErr);
                rollbackActions.push(async () =>
                  supabase
                    .from("sale_packaging")
                    .update({ packaging_item_id: oldPackId })
                    .in("sale_id", targetSaleIds)
                    .eq("packaging_item_id", newPackId),
                );
              }
            }
          }
        }

        const shopMenus = ((menuRows ?? []) as Array<Record<string, unknown>>)
          .filter((m) => matchesShopText(String(m.name ?? ""), targetShopId))
          .map((m) => String(m.id));

        if (shopMenus.length > 0) {
          const { data: recipeRows, error: recReadErr } = await supabase
            .from("menu_recipe_items")
            .select("id,menu_id,ingredient_id,packaging_item_id")
            .in("menu_id", shopMenus);
          if (recReadErr) dbError(recReadErr);

          for (const r of (recipeRows ?? []) as Array<Record<string, unknown>>) {
            const rowId = String(r.id);
            if (r.ingredient_id && ingIdMap.has(String(r.ingredient_id))) {
              const oldIngId = String(r.ingredient_id);
              const newIngId = ingIdMap.get(oldIngId)!;
              if (newIngId !== oldIngId) {
                const { error: recUpdErr } = await supabase
                  .from("menu_recipe_items")
                  .update({ ingredient_id: newIngId })
                  .eq("id", rowId);
                if (recUpdErr) dbError(recUpdErr);
                rollbackActions.push(async () =>
                  supabase.from("menu_recipe_items").update({ ingredient_id: oldIngId }).eq("id", rowId),
                );
              }
            } else if (r.packaging_item_id && packIdMap.has(String(r.packaging_item_id))) {
              const oldPackId = String(r.packaging_item_id);
              const newPackId = packIdMap.get(oldPackId)!;
              if (newPackId !== oldPackId) {
                const { error: recUpdErr } = await supabase
                  .from("menu_recipe_items")
                  .update({ packaging_item_id: newPackId })
                  .eq("id", rowId);
                if (recUpdErr) dbError(recUpdErr);
                rollbackActions.push(async () =>
                  supabase.from("menu_recipe_items").update({ packaging_item_id: oldPackId }).eq("id", rowId),
                );
              }
            }
          }
        }

        if (affectedIngIdsForCost.size > 0 || affectedPackIdsForCost.size > 0) {
          await recomputeCatalogItemCosts(supabase, user.id, affectedIngIdsForCost, affectedPackIdsForCost);
          await recomputeCatalogItemCosts(supabase, user.id, sourceIngIdsForReset, sourcePackIdsForReset, {
            resetWhenEmpty: true,
          });
        }
        await recalculateMenuCosts(supabase);

        const nextShops = rawShops.map((s) =>
          s.id === targetShopId ? { ...s, sharedIngredientsFromShopId: null } : s,
        );
        await writeShopsRegistry(supabase, user.id, rawShops, nextShops, nowIso);
      } catch (err) {
        let rollbackFailure: unknown = null;
        try {
          await executeRollbackActions(rollbackActions);
        } catch (error) {
          rollbackFailure = error;
        }
        await restoreCatalogCostSnapshots(supabase, costSnapshotIngredients, costSnapshotPackaging).catch(
          () => undefined,
        );
        if (rollbackFailure) {
          throw new Error(`${err instanceof Error ? err.message : String(err)}; ${String(rollbackFailure)}`);
        }
        throw err;
      }

      invalidateQueryCache();
      revalidatePath("/", "layout");
      return {
        ok: true,
        message: `แยกคลังวัตถุดิบและบรรจุภัณฑ์ของร้าน “${shopEntry.shopName}” ออกมาเป็นอิสระเรียบร้อยแล้ว`,
      };
    }

    // Case 2: Link targetShopId to requestedLinkShopId
    const requestedLinkShopId = normalizeShopId(rawLinkTo);
    const isValidTarget =
      requestedLinkShopId === DEFAULT_SHOP_ID || rawShops.some((s) => s.id === requestedLinkShopId);
    if (!isValidTarget) {
      throw new InputError("ไม่พบร้านเป้าหมายที่ต้องการเชื่อมคลังวัตถุดิบ");
    }

    const rootTargetId = resolveInventoryShopId(requestedLinkShopId, rawShops);
    if (rootTargetId === targetShopId) {
      throw new InputError("ไม่สามารถเชื่อมคลังวัตถุดิบเข้ากับร้านตัวเองได้");
    }

    if (currentInvShopId === rootTargetId) {
      const nextShops = rawShops.map((s) =>
        s.id === targetShopId ? { ...s, sharedIngredientsFromShopId: rootTargetId } : s,
      );
      await writeShopsRegistry(supabase, user.id, rawShops, nextShops, nowIso);
      invalidateQueryCache();
      revalidatePath("/", "layout");
      return { ok: true, message: "อัปเดตการเชื่อมคลังวัตถุดิบเรียบร้อยแล้ว" };
    }

    const [
      { data: ingRows, error: ingReadErr },
      { data: packRows, error: packReadErr },
      { data: packDefaultsRow, error: defReadErr },
      { data: menuRows, error: menuReadErr },
    ] = await Promise.all([
      supabase
        .from("ingredients")
        .select("id,name,category,costing,base_unit,purchase_unit,units_per_purchase_unit,price_per_purchase_unit_satang,weighted_unit_cost_satang,yield_auto,yield_updated_at,is_active")
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
      supabase.from("menus").select("id,name").eq("owner_id", user.id),
    ]);
    if (ingReadErr) dbError(ingReadErr);
    if (packReadErr) dbError(packReadErr);
    if (defReadErr) dbError(defReadErr);
    if (menuReadErr) dbError(menuReadErr);

    const allIngs = (ingRows ?? []) as Array<Record<string, unknown>>;
    const allPacks = (packRows ?? []) as Array<Record<string, unknown>>;
    const allIngById = new Map(allIngs.map((row) => [String(row.id), row]));
    const allPackById = new Map(allPacks.map((row) => [String(row.id), row]));
    const costSnapshotIngredients = allIngs.filter((row) =>
      [currentInvShopId, rootTargetId].some((shopId) => matchesShopText(String(row.name ?? ""), shopId)),
    );
    const costSnapshotPackaging = allPacks.filter((row) =>
      [currentInvShopId, rootTargetId].some((shopId) => matchesShopText(String(row.name ?? ""), shopId)),
    );

    const targetIngByName = new Map<string, string>();
    for (const r of allIngs) {
      if (matchesShopText(String(r.name ?? ""), rootTargetId)) {
        targetIngByName.set(normalizedCatalogName(r.name), String(r.id));
      }
    }

    const targetPackByName = new Map<string, string>();
    for (const r of allPacks) {
      if (matchesShopText(String(r.name ?? ""), rootTargetId)) {
        targetPackByName.set(normalizedCatalogName(r.name), String(r.id));
      }
    }

    const ingIdMap = new Map<string, string>();
    const packIdMap = new Map<string, string>();
    const obsoleteIngIds: string[] = [];
    const obsoletePackIds: string[] = [];
    const mergedTargetIngIds = new Set<string>();
    const mergedTargetPackIds = new Set<string>();
    const fallbackIngPrices = new Map<string, { pricePerPurchase: number; weightedUnit: number }>();
    const fallbackPackCosts = new Map<string, number>();

    const originalPackDefaults = { ...((packDefaultsRow?.value ?? {}) as Record<string, unknown>) };
    const packDefaultsMap: Record<string, unknown> = { ...originalPackDefaults };
    let packDefaultsChanged = false;
    const rollbackActions: Array<() => Promise<unknown>> = [];

    try {
      const sourceIngs = allIngs.filter((r) => matchesShopText(String(r.name ?? ""), currentInvShopId));
      for (const ing of sourceIngs) {
        const oldId = String(ing.id);
        const origName = String(ing.name ?? "");
        const cleanName = stripShopPrefix(origName);
        const normName = normalizedCatalogName(cleanName);
        const matchedTargetId = targetIngByName.get(normName);
        if (matchedTargetId) {
          const matchedTarget = allIngById.get(matchedTargetId);
          if (matchedTarget) assertIngredientCatalogCompatible(ing, matchedTarget);
        }

        if (currentInvShopId === targetShopId) {
          // Ensure purchase rows on this isolated ingredient retain [s:targetShopId] vendor prefix before moving/renaming
          const { data: oldPurRows, error: oldPurErr } = await supabase
            .from("ingredient_purchases")
            .select("id,vendor")
            .eq("ingredient_id", oldId);
          if (oldPurErr) dbError(oldPurErr);
          for (const p of (oldPurRows ?? []) as Array<Record<string, unknown>>) {
            const pId = String(p.id);
            const v = String(p.vendor ?? "");
            if (!v.startsWith("[s:")) {
              const { error: vUpdErr } = await supabase
                .from("ingredient_purchases")
                .update({ vendor: encodeShopText(v, targetShopId) })
                .eq("id", pId);
              if (vUpdErr) dbError(vUpdErr);
              rollbackActions.push(async () =>
                supabase.from("ingredient_purchases").update({ vendor: v || null }).eq("id", pId),
              );
            }
          }
        }

        if (matchedTargetId) {
          ingIdMap.set(oldId, matchedTargetId);
          if (currentInvShopId === targetShopId && matchedTargetId !== oldId) {
            const { data: movingPurRows } = await supabase
              .from("ingredient_purchases")
              .select("id")
              .eq("ingredient_id", oldId);
            const movingPurIds = (movingPurRows ?? []).map((p) => String((p as Record<string, unknown>).id));
            if (movingPurIds.length > 0) {
              const { error: movePurErr } = await supabase
                .from("ingredient_purchases")
                .update({ ingredient_id: matchedTargetId })
                .in("id", movingPurIds);
              if (movePurErr) dbError(movePurErr);
              rollbackActions.push(async () =>
                supabase
                  .from("ingredient_purchases")
                  .update({ ingredient_id: oldId })
                  .in("id", movingPurIds),
              );
            }
            mergedTargetIngIds.add(matchedTargetId);
            const srcPrice = Number(ing.price_per_purchase_unit_satang ?? 0);
            const srcWeighted = Number(ing.weighted_unit_cost_satang ?? 0);
            if (srcPrice > 0 || srcWeighted > 0) {
              fallbackIngPrices.set(matchedTargetId, {
                pricePerPurchase: srcPrice,
                weightedUnit: srcWeighted,
              });
            }
            obsoleteIngIds.push(oldId);
          }
        } else if (currentInvShopId === targetShopId) {
          // Move this isolated ingredient into rootTargetId's catalog
          const { error: renErr } = await supabase
            .from("ingredients")
            .update({ name: encodeShopText(cleanName, rootTargetId) })
            .eq("id", oldId);
          if (renErr) dbError(renErr);
          rollbackActions.push(async () =>
            supabase.from("ingredients").update({ name: origName }).eq("id", oldId),
          );
          ingIdMap.set(oldId, oldId);
          targetIngByName.set(normName, oldId);
        } else {
          // Switching from another shared catalog X to Y: clone missing item into Y
          const newId = await insertIngredientWithFallback(supabase, {
            owner_id: user.id,
            name: encodeShopText(cleanName, rootTargetId),
            category: ing.category,
            costing: ing.costing,
            base_unit: ing.base_unit,
            purchase_unit: ing.purchase_unit,
            units_per_purchase_unit: ing.units_per_purchase_unit,
            price_per_purchase_unit_satang: ing.price_per_purchase_unit_satang,
            weighted_unit_cost_satang: ing.weighted_unit_cost_satang,
            yield_auto: ing.yield_auto,
            yield_updated_at: ing.yield_updated_at,
            is_active: ing.is_active,
          });
          if (newId) {
            ingIdMap.set(oldId, newId);
            targetIngByName.set(normName, newId);
            fallbackIngPrices.set(newId, {
              pricePerPurchase: Number(ing.price_per_purchase_unit_satang ?? 0),
              weightedUnit: Number(ing.weighted_unit_cost_satang ?? 0),
            });
            rollbackActions.push(async () =>
              supabase.from("ingredients").delete().eq("id", newId),
            );
          }
        }
      }

      const sourcePacks = allPacks.filter((r) => matchesShopText(String(r.name ?? ""), currentInvShopId));
      for (const pack of sourcePacks) {
        const oldId = String(pack.id);
        const origName = String(pack.name ?? "");
        const cleanName = stripShopPrefix(origName);
        const normName = normalizedCatalogName(cleanName);
        const matchedTargetId = targetPackByName.get(normName);
        if (matchedTargetId) {
          const matchedTarget = allPackById.get(matchedTargetId);
          if (matchedTarget) assertPackagingCatalogCompatible(pack, matchedTarget);
        }

        if (currentInvShopId === targetShopId) {
          const { data: oldPackPurRows, error: oldPackPurErr } = await supabase
            .from("packaging_purchases")
            .select("id,vendor")
            .eq("packaging_item_id", oldId);
          if (oldPackPurErr) dbError(oldPackPurErr);
          for (const p of (oldPackPurRows ?? []) as Array<Record<string, unknown>>) {
            const pId = String(p.id);
            const v = String(p.vendor ?? "");
            if (!v.startsWith("[s:")) {
              const { error: vUpdErr } = await supabase
                .from("packaging_purchases")
                .update({ vendor: encodeShopText(v, targetShopId) })
                .eq("id", pId);
              if (vUpdErr) dbError(vUpdErr);
              rollbackActions.push(async () =>
                supabase.from("packaging_purchases").update({ vendor: v || null }).eq("id", pId),
              );
            }
          }
        }

        if (matchedTargetId) {
          packIdMap.set(oldId, matchedTargetId);
          if (currentInvShopId === targetShopId && matchedTargetId !== oldId) {
            const { data: movingPackPurs } = await supabase
              .from("packaging_purchases")
              .select("id")
              .eq("packaging_item_id", oldId);
            const movingPackPurIds = (movingPackPurs ?? []).map((p) => String((p as Record<string, unknown>).id));
            if (movingPackPurIds.length > 0) {
              const { error: movePackErr } = await supabase
                .from("packaging_purchases")
                .update({ packaging_item_id: matchedTargetId })
                .in("id", movingPackPurIds);
              if (movePackErr) dbError(movePackErr);
              rollbackActions.push(async () =>
                supabase
                  .from("packaging_purchases")
                  .update({ packaging_item_id: oldId })
                  .in("id", movingPackPurIds),
              );
            }

            const { data: movingSalePacks } = await supabase
              .from("sale_packaging")
              .select("id")
              .eq("packaging_item_id", oldId);
            const movingSalePackIds = (movingSalePacks ?? []).map((p) => String((p as Record<string, unknown>).id));
            if (movingSalePackIds.length > 0) {
              const { error: spErr } = await supabase
                .from("sale_packaging")
                .update({ packaging_item_id: matchedTargetId })
                .in("id", movingSalePackIds);
              if (spErr) dbError(spErr);
              rollbackActions.push(async () =>
                supabase
                  .from("sale_packaging")
                  .update({ packaging_item_id: oldId })
                  .in("id", movingSalePackIds),
              );
            }

            if (packDefaultsMap[oldId]) {
              if (!packDefaultsMap[matchedTargetId]) {
                packDefaultsMap[matchedTargetId] = packDefaultsMap[oldId];
              }
              delete packDefaultsMap[oldId];
              packDefaultsChanged = true;
            }
            mergedTargetPackIds.add(matchedTargetId);
            const srcUnitCost = Number(pack.unit_cost_satang ?? 0);
            if (srcUnitCost > 0) {
              fallbackPackCosts.set(matchedTargetId, srcUnitCost);
            }
            obsoletePackIds.push(oldId);
          }
        } else if (currentInvShopId === targetShopId) {
          const { error: renPackErr } = await supabase
            .from("packaging_items")
            .update({ name: encodeShopText(cleanName, rootTargetId) })
            .eq("id", oldId);
          if (renPackErr) dbError(renPackErr);
          rollbackActions.push(async () =>
            supabase.from("packaging_items").update({ name: origName }).eq("id", oldId),
          );
          packIdMap.set(oldId, oldId);
          targetPackByName.set(normName, oldId);
        } else {
          const newId = await insertPackagingWithFallback(supabase, {
            owner_id: user.id,
            name: encodeShopText(cleanName, rootTargetId),
            unit: pack.unit,
            per_order: pack.per_order,
            unit_cost_satang: pack.unit_cost_satang,
            is_active: pack.is_active,
          });
          if (newId) {
            packIdMap.set(oldId, newId);
            targetPackByName.set(normName, newId);
            fallbackPackCosts.set(newId, Number(pack.unit_cost_satang ?? 0));
            rollbackActions.push(async () =>
              supabase.from("packaging_items").delete().eq("id", newId),
            );
            if (packDefaultsMap[oldId]) {
              packDefaultsMap[newId] = packDefaultsMap[oldId];
              packDefaultsChanged = true;
            }
          }
        }
      }

      if (currentInvShopId !== targetShopId) {
        // Switching from shared catalog X to Y: move targetShopId's own purchases & sale_packaging to Y
        const targetPrefix = shopPrefix(targetShopId);
        if (targetPrefix) {
          const { data: targetSaleRows, error: targetSaleRowsError } = await supabase
            .from("sales")
            .select("id")
            .eq("owner_id", user.id)
            .like("notes", literalPrefixLike(targetPrefix));
          if (targetSaleRowsError) dbError(targetSaleRowsError);
          const targetSaleIds = (targetSaleRows ?? []).map((row) => String((row as Record<string, unknown>).id));
          for (const [oldIngId, newIngId] of ingIdMap.entries()) {
            if (oldIngId !== newIngId) {
              const { error: purMoveErr } = await supabase
                .from("ingredient_purchases")
                .update({ ingredient_id: newIngId })
                .eq("ingredient_id", oldIngId)
                .like("vendor", literalPrefixLike(targetPrefix));
              if (purMoveErr) dbError(purMoveErr);
              mergedTargetIngIds.add(oldIngId);
              mergedTargetIngIds.add(newIngId);
              rollbackActions.push(async () =>
                supabase
                  .from("ingredient_purchases")
                  .update({ ingredient_id: oldIngId })
                  .eq("ingredient_id", newIngId)
                  .like("vendor", literalPrefixLike(targetPrefix)),
              );
            }
          }
          for (const [oldPackId, newPackId] of packIdMap.entries()) {
            if (oldPackId !== newPackId) {
              const { error: packMoveErr } = await supabase
                .from("packaging_purchases")
                .update({ packaging_item_id: newPackId })
                .eq("packaging_item_id", oldPackId)
                .like("vendor", literalPrefixLike(targetPrefix));
              if (packMoveErr) dbError(packMoveErr);
              mergedTargetPackIds.add(oldPackId);
              mergedTargetPackIds.add(newPackId);
              rollbackActions.push(async () =>
                supabase
                  .from("packaging_purchases")
                  .update({ packaging_item_id: oldPackId })
                  .eq("packaging_item_id", newPackId)
                  .like("vendor", literalPrefixLike(targetPrefix)),
              );
              if (targetSaleIds.length > 0) {
                const { error: salePackMoveError } = await supabase
                  .from("sale_packaging")
                  .update({ packaging_item_id: newPackId })
                  .in("sale_id", targetSaleIds)
                  .eq("packaging_item_id", oldPackId);
                if (salePackMoveError) dbError(salePackMoveError);
                rollbackActions.push(async () =>
                  supabase
                    .from("sale_packaging")
                    .update({ packaging_item_id: oldPackId })
                    .in("sale_id", targetSaleIds)
                    .eq("packaging_item_id", newPackId),
                );
              }
            }
          }
        }
      }

      if (packDefaultsChanged) {
        const { error: defUpsertErr } = await supabase.from("settings").upsert(
          {
            owner_id: user.id,
            key: "packaging_defaults",
            value: packDefaultsMap,
            updated_at: nowIso,
          },
          { onConflict: "owner_id,key" },
        );
        if (defUpsertErr) dbError(defUpsertErr);
        rollbackActions.push(async () =>
          supabase.from("settings").upsert(
            {
              owner_id: user.id,
              key: "packaging_defaults",
              value: originalPackDefaults,
              updated_at: nowIso,
            },
            { onConflict: "owner_id,key" },
          ),
        );
      }

      await recomputeCatalogItemCosts(supabase, user.id, mergedTargetIngIds, mergedTargetPackIds, {
        fallbackIngPrices,
        fallbackPackCosts,
        resetWhenEmpty: true,
      });

      const affectedShopIds = new Set<string>([targetShopId]);
      for (const s of rawShops) {
        if (s.sharedIngredientsFromShopId === targetShopId) {
          affectedShopIds.add(s.id);
        }
      }

      const shopMenus = ((menuRows ?? []) as Array<Record<string, unknown>>)
        .filter((m) =>
          Array.from(affectedShopIds).some((sid) => matchesShopText(String(m.name ?? ""), sid)),
        )
        .map((m) => String(m.id));

      if (shopMenus.length > 0) {
        const { data: recipeRows, error: recReadErr } = await supabase
          .from("menu_recipe_items")
          .select("id,menu_id,ingredient_id,packaging_item_id,quantity")
          .in("menu_id", shopMenus);
        if (recReadErr) dbError(recReadErr);

        const seenMenuIng = new Map<string, { rowId: string; quantity: number }>();
        const seenMenuPack = new Map<string, { rowId: string; quantity: number }>();

        for (const r of (recipeRows ?? []) as Array<Record<string, unknown>>) {
          const rowId = String(r.id);
          const mId = String(r.menu_id);
          if (r.ingredient_id) {
            const origIngId = String(r.ingredient_id);
            const mappedIngId = ingIdMap.get(origIngId) ?? origIngId;
            const key = `${mId}:${mappedIngId}`;
            const previous = seenMenuIng.get(key);
            if (previous) {
              const previousQuantity = previous.quantity;
              const mergedQuantity = previousQuantity + Number(r.quantity ?? 0);
              const { error: quantityUpdateError } = await supabase
                .from("menu_recipe_items")
                .update({ quantity: mergedQuantity })
                .eq("id", previous.rowId);
              if (quantityUpdateError) dbError(quantityUpdateError);
              const { error: delRecErr } = await supabase.from("menu_recipe_items").delete().eq("id", rowId);
              if (delRecErr) dbError(delRecErr);
              previous.quantity = mergedQuantity;
              rollbackActions.push(async () => {
                await supabase.from("menu_recipe_items").update({ quantity: previousQuantity }).eq("id", previous.rowId);
                return supabase.from("menu_recipe_items").insert({
                  id: rowId,
                  owner_id: user.id,
                  menu_id: mId,
                  ingredient_id: origIngId,
                  packaging_item_id: null,
                  quantity: r.quantity,
                });
              });
            } else {
              seenMenuIng.set(key, { rowId, quantity: Number(r.quantity ?? 0) });
              if (mappedIngId !== origIngId) {
                const { error: updRecErr } = await supabase
                  .from("menu_recipe_items")
                  .update({ ingredient_id: mappedIngId })
                  .eq("id", rowId);
                if (updRecErr) dbError(updRecErr);
                rollbackActions.push(async () =>
                  supabase.from("menu_recipe_items").update({ ingredient_id: origIngId }).eq("id", rowId),
                );
              }
            }
          } else if (r.packaging_item_id) {
            const origPackId = String(r.packaging_item_id);
            const mappedPackId = packIdMap.get(origPackId) ?? origPackId;
            const key = `${mId}:${mappedPackId}`;
            const previous = seenMenuPack.get(key);
            if (previous) {
              const previousQuantity = previous.quantity;
              const mergedQuantity = previousQuantity + Number(r.quantity ?? 0);
              const { error: quantityUpdateError } = await supabase
                .from("menu_recipe_items")
                .update({ quantity: mergedQuantity })
                .eq("id", previous.rowId);
              if (quantityUpdateError) dbError(quantityUpdateError);
              const { error: delRecErr } = await supabase.from("menu_recipe_items").delete().eq("id", rowId);
              if (delRecErr) dbError(delRecErr);
              previous.quantity = mergedQuantity;
              rollbackActions.push(async () => {
                await supabase.from("menu_recipe_items").update({ quantity: previousQuantity }).eq("id", previous.rowId);
                return supabase.from("menu_recipe_items").insert({
                  id: rowId,
                  owner_id: user.id,
                  menu_id: mId,
                  ingredient_id: null,
                  packaging_item_id: origPackId,
                  quantity: r.quantity,
                });
              });
            } else {
              seenMenuPack.set(key, { rowId, quantity: Number(r.quantity ?? 0) });
              if (mappedPackId !== origPackId) {
                const { error: updRecErr } = await supabase
                  .from("menu_recipe_items")
                  .update({ packaging_item_id: mappedPackId })
                  .eq("id", rowId);
                if (updRecErr) dbError(updRecErr);
                rollbackActions.push(async () =>
                  supabase.from("menu_recipe_items").update({ packaging_item_id: origPackId }).eq("id", rowId),
                );
              }
            }
          }
        }
      }

      if (obsoleteIngIds.length > 0) {
        const obsoleteIngredientRows = allIngs
          .filter((row) => obsoleteIngIds.includes(String(row.id)))
          .map((row) => ({ ...row, owner_id: user.id }));
        const { data: obsoleteIngredientRecipes, error: obsoleteIngredientRecipesError } = await supabase
          .from("menu_recipe_items")
          .select("*")
          .in("ingredient_id", obsoleteIngIds);
        if (obsoleteIngredientRecipesError) dbError(obsoleteIngredientRecipesError);
        const { error: delObsoleteRecIngErr } = await supabase
          .from("menu_recipe_items")
          .delete()
          .in("ingredient_id", obsoleteIngIds);
        if (delObsoleteRecIngErr) dbError(delObsoleteRecIngErr);
        const { error: delObsoleteIngErr } = await supabase
          .from("ingredients")
          .delete()
          .in("id", obsoleteIngIds);
        if (delObsoleteIngErr) dbError(delObsoleteIngErr);
        rollbackActions.push(async () => {
          if (obsoleteIngredientRows.length > 0) {
            await supabase.from("ingredients").insert(obsoleteIngredientRows);
          }
          if ((obsoleteIngredientRecipes ?? []).length > 0) {
            return supabase.from("menu_recipe_items").insert(obsoleteIngredientRecipes!);
          }
          return undefined;
        });
      }
      if (obsoletePackIds.length > 0) {
        const obsoletePackagingRows = allPacks
          .filter((row) => obsoletePackIds.includes(String(row.id)))
          .map((row) => ({ ...row, owner_id: user.id }));
        const [
          { data: obsoletePackagingRecipes, error: obsoletePackagingRecipesError },
          { data: obsoleteSalePackaging, error: obsoleteSalePackagingError },
        ] = await Promise.all([
          supabase.from("menu_recipe_items").select("*").in("packaging_item_id", obsoletePackIds),
          supabase.from("sale_packaging").select("*").in("packaging_item_id", obsoletePackIds),
        ]);
        if (obsoletePackagingRecipesError) dbError(obsoletePackagingRecipesError);
        if (obsoleteSalePackagingError) dbError(obsoleteSalePackagingError);
        const { error: delObsoleteRecPackErr } = await supabase
          .from("menu_recipe_items")
          .delete()
          .in("packaging_item_id", obsoletePackIds);
        if (delObsoleteRecPackErr) dbError(delObsoleteRecPackErr);
        const { error: delObsoleteSpErr } = await supabase
          .from("sale_packaging")
          .delete()
          .in("packaging_item_id", obsoletePackIds);
        if (delObsoleteSpErr) dbError(delObsoleteSpErr);
        const { error: delObsoletePackErr } = await supabase
          .from("packaging_items")
          .delete()
          .in("id", obsoletePackIds);
        if (delObsoletePackErr) dbError(delObsoletePackErr);
        rollbackActions.push(async () => {
          if (obsoletePackagingRows.length > 0) {
            await supabase.from("packaging_items").insert(obsoletePackagingRows);
          }
          if ((obsoletePackagingRecipes ?? []).length > 0) {
            await supabase.from("menu_recipe_items").insert(obsoletePackagingRecipes!);
          }
          if ((obsoleteSalePackaging ?? []).length > 0) {
            return supabase.from("sale_packaging").insert(obsoleteSalePackaging!);
          }
          return undefined;
        });
      }

      // Recalculate menu costs across all shops since merged pooled rates may affect rootTargetId's menus too
      await recalculateMenuCosts(supabase);

      const nextShops = rawShops.map((s) => {
        if (s.id === targetShopId) {
          return { ...s, sharedIngredientsFromShopId: rootTargetId };
        }
        if (s.sharedIngredientsFromShopId === targetShopId) {
          return { ...s, sharedIngredientsFromShopId: rootTargetId };
        }
        return s;
      });

      await writeShopsRegistry(supabase, user.id, rawShops, nextShops, nowIso);
    } catch (err) {
      let rollbackFailure: unknown = null;
      try {
        await executeRollbackActions(rollbackActions);
      } catch (error) {
        rollbackFailure = error;
      }
      await restoreCatalogCostSnapshots(supabase, costSnapshotIngredients, costSnapshotPackaging).catch(
        () => undefined,
      );
      if (rollbackFailure) {
        throw new Error(`${err instanceof Error ? err.message : String(err)}; ${String(rollbackFailure)}`);
      }
      throw err;
    }

    invalidateQueryCache();
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: `เชื่อมคลังวัตถุดิบและบรรจุภัณฑ์ของร้าน “${shopEntry.shopName}” เรียบร้อยแล้ว`,
    };
  });
}

export async function deleteShopAction(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId: currentActiveShopId }) => {
    const targetShopId = normalizeShopId(String(form.get("shop_id") ?? ""));
    if (!targetShopId || targetShopId === DEFAULT_SHOP_ID) {
      throw new InputError("ไม่สามารถลบร้านหลักได้");
    }

    const { data: regRow, error: regReadErr } = await supabase
      .from("settings")
      .select("value")
      .eq("owner_id", user.id)
      .eq("key", SHOPS_REGISTRY_SETTINGS_KEY)
      .maybeSingle();
    if (regReadErr) dbError(regReadErr);
    const rawShops = ((regRow?.value as { shops?: ShopSummary[] } | null)?.shops ?? []) as ShopSummary[];
    const targetShop = rawShops.find((s) => s.id === targetShopId);
    if (!targetShop) {
      throw new InputError("ไม่พบร้านที่ต้องการลบ");
    }

    const prefix = shopPrefix(targetShopId);
    const [expenseFilesResult, saleFilesResult, menuFilesResult] = await Promise.all([
      supabase
        .from("expenses")
        .select("receipt_path")
        .eq("owner_id", user.id)
        .like("description", literalPrefixLike(prefix)),
      supabase
        .from("sales")
        .select("id")
        .eq("owner_id", user.id)
        .like("notes", literalPrefixLike(prefix)),
      supabase
        .from("menus")
        .select("image_path")
        .eq("owner_id", user.id)
        .like("name", literalPrefixLike(prefix)),
    ]);
    if (expenseFilesResult.error) dbError(expenseFilesResult.error);
    if (saleFilesResult.error) dbError(saleFilesResult.error);
    if (menuFilesResult.error) dbError(menuFilesResult.error);
    const deletedSaleIds = ((saleFilesResult.data ?? []) as Array<Record<string, unknown>>).map((row) => String(row.id));
    let slipPaths: string[] = [];
    if (deletedSaleIds.length > 0) {
      const { data: slipRows, error: slipRowsError } = await supabase
        .from("slip_uploads")
        .select("storage_path")
        .in("sale_id", deletedSaleIds);
      if (slipRowsError) dbError(slipRowsError);
      slipPaths = ((slipRows ?? []) as Array<Record<string, unknown>>).map((row) => String(row.storage_path ?? ""));
    }
    const receiptPaths = ((expenseFilesResult.data ?? []) as Array<Record<string, unknown>>).map((row) =>
      String(row.receipt_path ?? ""),
    );
    const menuImageUrls = ((menuFilesResult.data ?? []) as Array<Record<string, unknown>>).map((row) =>
      String(row.image_path ?? ""),
    );
    const dependents = rawShops.filter(
      (s) => s.id !== targetShopId && resolveInventoryShopId(s.id, rawShops) === targetShopId,
    );
    const newOwnerShopId = dependents.length > 0 ? dependents[0].id : null;
    const nextShops = rawShops
      .filter((s) => s.id !== targetShopId)
      .map((s) => {
        if (resolveInventoryShopId(s.id, rawShops) === targetShopId) {
          return {
            ...s,
            sharedIngredientsFromShopId: s.id === newOwnerShopId ? null : newOwnerShopId,
          };
        }
        return s;
      });

    const deleteShopRpc = (supabase as unknown as {
      rpc?: (
        name: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;
    }).rpc;
    if (typeof deleteShopRpc === "function") {
      const { data, error } = await deleteShopRpc.call(supabase, "delete_shop_transaction", {
        p_shop_id: targetShopId,
        p_expected_shops: rawShops,
        p_next_shops: nextShops,
        p_new_catalog_owner: newOwnerShopId,
      });
      if (error?.code === "40001") {
        throw new InputError("ข้อมูลร้านถูกแก้ไขจากอีกหน้าต่าง กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง");
      }
      if (!error) {
        const result = (data ?? {}) as {
          affectedIngredientIds?: unknown[];
          affectedPackagingIds?: unknown[];
        };
        const affectedIngredientIds = (result.affectedIngredientIds ?? []).map(String);
        const affectedPackagingIds = (result.affectedPackagingIds ?? []).map(String);
        if (affectedIngredientIds.length > 0 || affectedPackagingIds.length > 0) {
          await recomputeCatalogItemCosts(supabase, user.id, affectedIngredientIds, affectedPackagingIds, {
            resetWhenEmpty: true,
          });
          await recalculateMenuCosts(supabase);
        }
        await supabase
          .from("settings")
          .delete()
          .eq("owner_id", user.id)
          .eq("key", scopedSettingsKey("line_loyalty", targetShopId));
        await supabase
          .from("loyalty_members")
          .delete()
          .eq("owner_id", user.id)
          .eq("shop_scope_id", targetShopId);
        await cleanupUnreferencedShopFiles(supabase, receiptPaths, slipPaths, menuImageUrls);
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
        return { ok: true, message: `ลบร้าน “${targetShop.shopName}” เรียบร้อยแล้ว` };
      }
      if (!isMissingRpcError(error, "delete_shop_transaction")) {
        dbError(error);
      }
    }

    // 1. Find expenses of this shop & clean up any ingredient_purchases / packaging_purchases made by this shop (including on shared catalogs)
    const { data: shopExpRows, error: expReadErr } = await supabase
      .from("expenses")
      .select("id")
      .eq("owner_id", user.id)
      .like("description", literalPrefixLike(prefix));
    if (expReadErr) dbError(expReadErr);
    const shopExpenseIds = (shopExpRows ?? []).map((e) => String((e as Record<string, unknown>).id));

    const affectedSharedIngIds = new Set<string>();
    const affectedSharedPackIds = new Set<string>();
    const ingPurchaseIdsToDelete = new Set<string>();
    const packPurchaseIdsToDelete = new Set<string>();

    const { data: vendorIngPurs, error: vIngPurErr } = await supabase
      .from("ingredient_purchases")
      .select("id,ingredient_id")
      .eq("owner_id", user.id)
      .like("vendor", literalPrefixLike(prefix));
    if (vIngPurErr) dbError(vIngPurErr);
    for (const p of (vendorIngPurs ?? []) as Array<Record<string, unknown>>) {
      ingPurchaseIdsToDelete.add(String(p.id));
      if (p.ingredient_id) affectedSharedIngIds.add(String(p.ingredient_id));
    }

    const { data: vendorPackPurs, error: vPackPurErr } = await supabase
      .from("packaging_purchases")
      .select("id,packaging_item_id")
      .eq("owner_id", user.id)
      .like("vendor", literalPrefixLike(prefix));
    if (vPackPurErr) dbError(vPackPurErr);
    for (const p of (vendorPackPurs ?? []) as Array<Record<string, unknown>>) {
      packPurchaseIdsToDelete.add(String(p.id));
      if (p.packaging_item_id) affectedSharedPackIds.add(String(p.packaging_item_id));
    }

    if (shopExpenseIds.length > 0) {
      const { data: expIngPurs, error: expIngErr } = await supabase
        .from("ingredient_purchases")
        .select("id,ingredient_id")
        .in("expense_id", shopExpenseIds);
      if (!expIngErr && expIngPurs) {
        for (const p of expIngPurs as Array<Record<string, unknown>>) {
          ingPurchaseIdsToDelete.add(String(p.id));
          if (p.ingredient_id) affectedSharedIngIds.add(String(p.ingredient_id));
        }
      }
      const { data: expPackPurs, error: expPackErr } = await supabase
        .from("packaging_purchases")
        .select("id,packaging_item_id")
        .in("expense_id", shopExpenseIds);
      if (!expPackErr && expPackPurs) {
        for (const p of expPackPurs as Array<Record<string, unknown>>) {
          packPurchaseIdsToDelete.add(String(p.id));
          if (p.packaging_item_id) affectedSharedPackIds.add(String(p.packaging_item_id));
        }
      }
    }

    if (ingPurchaseIdsToDelete.size > 0) {
      const { error: delIngPurErr } = await supabase
        .from("ingredient_purchases")
        .delete()
        .in("id", Array.from(ingPurchaseIdsToDelete));
      if (delIngPurErr) dbError(delIngPurErr);
    }
    if (packPurchaseIdsToDelete.size > 0) {
      const { error: delPackPurErr } = await supabase
        .from("packaging_purchases")
        .delete()
        .in("id", Array.from(packPurchaseIdsToDelete));
      if (delPackPurErr) dbError(delPackPurErr);
    }

    // 2. Delete expenses & sales of this shop FIRST so ON DELETE RESTRICT on sale_items / sale_packaging does not block menu/packaging deletion
    const { error: delExpErr } = await supabase
      .from("expenses")
      .delete()
      .eq("owner_id", user.id)
      .like("description", literalPrefixLike(prefix));
    if (delExpErr) dbError(delExpErr);

    const { error: delSalesErr } = await supabase
      .from("sales")
      .delete()
      .eq("owner_id", user.id)
      .like("notes", literalPrefixLike(prefix));
    if (delSalesErr) dbError(delSalesErr);

    // 3. Delete menus & recipe items of this shop
    const { data: shopMenus, error: menuReadErr } = await supabase
      .from("menus")
      .select("id")
      .eq("owner_id", user.id)
      .like("name", literalPrefixLike(prefix));
    if (menuReadErr) dbError(menuReadErr);
    const shopMenuIds = (shopMenus ?? []).map((m) => String((m as Record<string, unknown>).id));
    if (shopMenuIds.length > 0) {
      const { error: delSiErr } = await supabase.from("sale_items").delete().in("menu_id", shopMenuIds);
      if (delSiErr) dbError(delSiErr);
      const { error: delMriErr } = await supabase.from("menu_recipe_items").delete().in("menu_id", shopMenuIds);
      if (delMriErr) dbError(delMriErr);
      const { error: delMenuErr } = await supabase.from("menus").delete().in("id", shopMenuIds);
      if (delMenuErr) dbError(delMenuErr);
    }

    // 4. Handle ingredients & packaging of this shop (transfer to dependent shop if shared, else delete)
    const { data: shopIngs, error: shopIngErr } = await supabase
      .from("ingredients")
      .select("id,name")
      .eq("owner_id", user.id)
      .like("name", literalPrefixLike(prefix));
    if (shopIngErr) dbError(shopIngErr);
    const shopIngRows = (shopIngs ?? []) as Array<Record<string, unknown>>;
    if (shopIngRows.length > 0) {
      if (newOwnerShopId) {
        for (const ing of shopIngRows) {
          const cleanName = stripShopPrefix(String(ing.name ?? ""));
          const { error: renIngErr } = await supabase
            .from("ingredients")
            .update({ name: encodeShopText(cleanName, newOwnerShopId) })
            .eq("id", String(ing.id));
          if (renIngErr) dbError(renIngErr);
        }
      } else {
        const shopIngIds = shopIngRows.map((i) => String(i.id));
        for (const idStr of shopIngIds) affectedSharedIngIds.delete(idStr);
        const { error: delRecErr } = await supabase.from("menu_recipe_items").delete().in("ingredient_id", shopIngIds);
        if (delRecErr) dbError(delRecErr);
        const { error: delPurErr } = await supabase.from("ingredient_purchases").delete().in("ingredient_id", shopIngIds);
        if (delPurErr) dbError(delPurErr);
        const { error: delIngErr } = await supabase.from("ingredients").delete().in("id", shopIngIds);
        if (delIngErr) dbError(delIngErr);
      }
    }

    // 5. Handle packaging & purchases of this shop
    const { data: shopPacks, error: shopPackErr } = await supabase
      .from("packaging_items")
      .select("id,name")
      .eq("owner_id", user.id)
      .like("name", literalPrefixLike(prefix));
    if (shopPackErr) dbError(shopPackErr);
    const shopPackRows = (shopPacks ?? []) as Array<Record<string, unknown>>;
    if (shopPackRows.length > 0) {
      if (newOwnerShopId) {
        for (const pack of shopPackRows) {
          const cleanName = stripShopPrefix(String(pack.name ?? ""));
          const { error: renPackErr } = await supabase
            .from("packaging_items")
            .update({ name: encodeShopText(cleanName, newOwnerShopId) })
            .eq("id", String(pack.id));
          if (renPackErr) dbError(renPackErr);
        }
      } else {
        const shopPackIds = shopPackRows.map((p) => String(p.id));
        for (const idStr of shopPackIds) affectedSharedPackIds.delete(idStr);
        const { error: delSpErr } = await supabase.from("sale_packaging").delete().in("packaging_item_id", shopPackIds);
        if (delSpErr) dbError(delSpErr);
        const { error: delRecErr } = await supabase.from("menu_recipe_items").delete().in("packaging_item_id", shopPackIds);
        if (delRecErr) dbError(delRecErr);
        const { error: delPurErr } = await supabase.from("packaging_purchases").delete().in("packaging_item_id", shopPackIds);
        if (delPurErr) dbError(delPurErr);
        const { error: delPackErr } = await supabase.from("packaging_items").delete().in("id", shopPackIds);
        if (delPackErr) dbError(delPackErr);
      }
    }

    // 6. Recompute costs of shared/transferred catalog items whose purchases were removed, then recalculate menu costs
    if (affectedSharedIngIds.size > 0 || affectedSharedPackIds.size > 0) {
      await recomputeCatalogItemCosts(supabase, user.id, affectedSharedIngIds, affectedSharedPackIds, {
        resetWhenEmpty: true,
      });
      await recalculateMenuCosts(supabase);
    }

    // 7. Remove from shops_registry and delete scoped settings
    await writeShopsRegistry(supabase, user.id, rawShops, nextShops, new Date().toISOString());

    const { error: delSettingsErr } = await supabase
      .from("settings")
      .delete()
      .eq("owner_id", user.id)
      .in("key", [
        scopedSettingsKey("profile", targetShopId),
        scopedSettingsKey("sales", targetShopId),
        scopedSettingsKey("price_presets", targetShopId),
        scopedSettingsKey("line_loyalty", targetShopId),
      ]);
    if (delSettingsErr) dbError(delSettingsErr);

    if (currentActiveShopId === targetShopId) {
      const cookieStore = await cookies();
      cookieStore.set(ACTIVE_SHOP_COOKIE, DEFAULT_SHOP_ID, {
        path: "/",
        maxAge: 365 * 24 * 60 * 60,
        sameSite: "lax",
      });
    }

    await cleanupUnreferencedShopFiles(supabase, receiptPaths, slipPaths, menuImageUrls);

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
