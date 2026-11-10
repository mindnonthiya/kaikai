"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { MENU_YIELDS_SETTINGS_KEY, invalidateQueryCache } from "@/lib/data/queries";
import { ADDON_CATEGORY, DISH_CATEGORY, SERVICE_CATEGORY } from "@/lib/data/types";
import { recalculateMenuCosts } from "@/lib/menu-cost";
import { syncHistoricalCosts } from "@/lib/historical-cost-sync";
import { encodeShopText, matchesShopText } from "@/lib/shop-scope";
import { InputError, amountOrZero, dbError, id, money, oneOf, quantity, runAction, text } from "@/lib/server-action";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f-]{36}$/i;

function revalidateMenus() {
  invalidateQueryCache("menus");
  invalidateQueryCache("menu_yields");
  invalidateQueryCache("recipes");
  invalidateQueryCache("pooled_rate");
  revalidatePath("/menus");
  revalidatePath("/sales/new");
  revalidatePath("/dashboard");
  revalidatePath("/reports");
}

export async function saveMenu(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId }) => {
    const menuId = String(form.get("id") ?? "") || null;
    const name = text(form, "name", "ชื่อเมนู", { max: 120 });
    const category = oneOf(form, "category", [DISH_CATEGORY, ADDON_CATEGORY, SERVICE_CATEGORY] as const, "ประเภทเมนู");
    const price = money(form, "price", "ราคาขาย", { required: true, positive: true });
    const removeImage = form.get("remove_image") === "true";
    const imageFile = form.get("image") as File | null;

    const fields: Record<string, unknown> = {
      name: encodeShopText(name, shopId),
      category,
      selling_price_satang: price,
      updated_at: new Date().toISOString(),
    };

    if (removeImage) {
      fields.image_path = null;
    } else if (imageFile && imageFile.size > 0) {
      if (imageFile.size > 5 * 1024 * 1024) {
        throw new InputError("รูปภาพต้องมีขนาดไม่เกิน 5 MB");
      }
      const buffer = Buffer.from(await imageFile.arrayBuffer());
      const ext = imageFile.name.split(".").pop()?.toLowerCase() || "jpg";
      const cleanExt = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext) ? ext : "jpg";
      const randomPart = Math.random().toString(36).substring(2, 8);
      const filePath = `${user.id}/${Date.now()}_${randomPart}.${cleanExt}`;

      try {
        const { error: uploadError } = await supabase.storage
          .from("menu-images")
          .upload(filePath, buffer, {
            contentType: imageFile.type || "image/jpeg",
            upsert: true,
          });

        if (!uploadError) {
          const { data: { publicUrl } } = supabase.storage.from("menu-images").getPublicUrl(filePath);
          fields.image_path = publicUrl;
        } else {
          if (buffer.length <= 2 * 1024 * 1024) {
            fields.image_path = `data:${imageFile.type || "image/jpeg"};base64,${buffer.toString("base64")}`;
          }
        }
      } catch {
        if (buffer.length <= 2 * 1024 * 1024) {
          fields.image_path = `data:${imageFile.type || "image/jpeg"};base64,${buffer.toString("base64")}`;
        }
      }
    }

    const unique = { unique: `มีเมนูชื่อ “${name}” อยู่แล้ว` };

    let savedId = menuId;
    if (menuId) {
      const { data: existingMenu } = await supabase.from("menus").select("id,name").eq("id", menuId).maybeSingle();
      if (!existingMenu || !matchesShopText(String((existingMenu as Row).name ?? ""), shopId)) {
        throw new InputError("ไม่พบเมนูในร้านปัจจุบัน");
      }
      const { error } = await supabase.from("menus").update(fields).eq("id", menuId);
      if (error) dbError(error, unique);
    } else {
      const { data, error } = await supabase.from("menus")
        .insert({ ...fields, owner_id: user.id, current_cost_satang: 0, is_available: true })
        .select("id").single();
      if (error) dbError(error, unique);
      savedId = String((data as Row).id);
      // Packaging is selected in each menu's recipe; creating a menu does not attach all supplies.
    }
    await recalculateMenuCosts(supabase, [savedId!]);
    revalidateMenus();
    return { ok: true, message: menuId ? "บันทึกการแก้ไขแล้ว" : `เพิ่มเมนู “${name}” แล้ว` };
  });
}

/**
 * Saves a whole recipe at once from stepper fields `pack_<id>` (packaging) and `ing_<id>` (per-unit ingredients),
 * plus optional `recipe_yield` (how many servings/crepes/dishes this batch recipe makes; default 1).
 * Only items present in the form are replaced; 0 removes the item from the recipe.
 */
export async function saveMenuRecipe(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user, shopId, inventoryShopId }) => {
    const menuId = id(form, "menu_id");
    const rawYieldStr = String(form.get("recipe_yield") ?? "").trim();
    const recipeYield = rawYieldStr ? quantity(form, "recipe_yield", "จำนวนเสิร์ฟต่อสูตร")! : 1;

    let { data: existingMenu } = await supabase.from("menus").select("id,name,recipe_yield").eq("id", menuId).maybeSingle();
    if (!existingMenu) {
      const fallbackMenu = await supabase.from("menus").select("id,name").eq("id", menuId).maybeSingle();
      existingMenu = fallbackMenu.data as typeof existingMenu;
    }
    if (!existingMenu || !matchesShopText(String((existingMenu as Row).name ?? ""), shopId)) {
      throw new InputError("ไม่พบเมนูในร้านปัจจุบัน");
    }

    const packIds: string[] = [], ingredientIds: string[] = [];
    const insert: Row[] = [];
    for (const key of new Set(form.keys())) {
      const match = /^(pack|ing)_(.+)$/.exec(key);
      if (!match) continue;
      const [, kind, itemId] = match;
      if (!UUID.test(itemId)) throw new InputError("ไม่พบรายการ");
      const amount = amountOrZero(form, key, "จำนวน");
      (kind === "pack" ? packIds : ingredientIds).push(itemId);
      if (amount > 0) {
        insert.push({
          owner_id: user.id, menu_id: menuId, quantity: amount,
          packaging_item_id: kind === "pack" ? itemId : null, ingredient_id: kind === "ing" ? itemId : null,
        });
      }
    }
    if (packIds.length) {
      const { data: packRows, error: packReadErr } = await supabase
        .from("packaging_items")
        .select("id,name")
        .in("id", packIds);
      if (packReadErr) dbError(packReadErr);
      const validPackIds = new Set(
        ((packRows ?? []) as Row[])
          .filter((r) => matchesShopText(String(r.name ?? ""), inventoryShopId))
          .map((r) => String(r.id)),
      );
      if (packIds.some((pid) => !validPackIds.has(pid))) {
        throw new InputError("รายการบรรจุภัณฑ์ไม่ได้อยู่ในคลังของร้านปัจจุบัน");
      }
    }
    if (ingredientIds.length) {
      const { data: ingRows, error: ingReadErr } = await supabase
        .from("ingredients")
        .select("id,name")
        .in("id", ingredientIds);
      if (ingReadErr) dbError(ingReadErr);
      const validIngIds = new Set(
        ((ingRows ?? []) as Row[])
          .filter((r) => matchesShopText(String(r.name ?? ""), inventoryShopId))
          .map((r) => String(r.id)),
      );
      if (ingredientIds.some((iid) => !validIngIds.has(iid))) {
        throw new InputError("รายการวัตถุดิบไม่ได้อยู่ในคลังของร้านปัจจุบัน");
      }
    }
    const [packSnapshotResult, ingredientSnapshotResult, yieldsResult] = await Promise.all([
      packIds.length
        ? supabase.from("menu_recipe_items").select("*").eq("menu_id", menuId).in("packaging_item_id", packIds)
        : Promise.resolve({ data: [], error: null }),
      ingredientIds.length
        ? supabase.from("menu_recipe_items").select("*").eq("menu_id", menuId).in("ingredient_id", ingredientIds)
        : Promise.resolve({ data: [], error: null }),
      supabase.from("settings").select("value").eq("key", MENU_YIELDS_SETTINGS_KEY).maybeSingle(),
    ]);
    if (packSnapshotResult.error) dbError(packSnapshotResult.error);
    if (ingredientSnapshotResult.error) dbError(ingredientSnapshotResult.error);
    if (yieldsResult.error) dbError(yieldsResult.error);
    const recipeSnapshot = [...(packSnapshotResult.data ?? []), ...(ingredientSnapshotResult.data ?? [])];
    const originalYieldsMap: Record<string, number> = {
      ...((yieldsResult.data?.value ?? {}) as Record<string, number>),
    };
    const originalRecipeYield = Number((existingMenu as Row).recipe_yield ?? originalYieldsMap[menuId] ?? 1);

    try {
      if (packIds.length) {
        const { error } = await supabase.from("menu_recipe_items").delete().eq("menu_id", menuId).in("packaging_item_id", packIds);
        if (error) dbError(error);
      }
      if (ingredientIds.length) {
        const { error } = await supabase.from("menu_recipe_items").delete().eq("menu_id", menuId).in("ingredient_id", ingredientIds);
        if (error) dbError(error);
      }
      if (insert.length) {
        const { error } = await supabase.from("menu_recipe_items").insert(insert);
        if (error) dbError(error);
      }

      const yieldsMap: Record<string, number> = { ...originalYieldsMap };
      if (recipeYield === 1) {
        delete yieldsMap[menuId];
      } else {
        yieldsMap[menuId] = recipeYield;
      }
      const { error: yieldSetErr } = await supabase.from("settings").upsert(
        { owner_id: user.id, key: MENU_YIELDS_SETTINGS_KEY, value: yieldsMap, updated_at: new Date().toISOString() },
        { onConflict: "owner_id,key" },
      );
      if (yieldSetErr) dbError(yieldSetErr);
      const { error: menuYieldError } = await supabase.from("menus").update({ recipe_yield: recipeYield }).eq("id", menuId);
      if (menuYieldError && menuYieldError.code !== "42703" && menuYieldError.code !== "PGRST204") dbError(menuYieldError);

      await recalculateMenuCosts(supabase, [menuId]);
    } catch (error) {
      if (packIds.length) {
        await supabase.from("menu_recipe_items").delete().eq("menu_id", menuId).in("packaging_item_id", packIds);
      }
      if (ingredientIds.length) {
        await supabase.from("menu_recipe_items").delete().eq("menu_id", menuId).in("ingredient_id", ingredientIds);
      }
      if (recipeSnapshot.length > 0) await supabase.from("menu_recipe_items").insert(recipeSnapshot);
      await supabase.from("settings").upsert(
        { owner_id: user.id, key: MENU_YIELDS_SETTINGS_KEY, value: originalYieldsMap, updated_at: new Date().toISOString() },
        { onConflict: "owner_id,key" },
      );
      await supabase.from("menus").update({ recipe_yield: originalRecipeYield }).eq("id", menuId);
      await recalculateMenuCosts(supabase, [menuId]).catch(() => undefined);
      throw error;
    }

    const syncPastSales = form.get("sync_past_sales") === "true" || form.get("sync_past_sales") === "on";
    let syncedMessage = "";
    if (syncPastSales) {
      try {
        const syncResult = await syncHistoricalCosts(supabase, {
          ownerId: user.id,
          menuId,
          forceAll: true,
        });
        revalidatePath("/sales");
        revalidatePath("/reports");
        if (syncResult.affectedSalesCount > 0) {
          syncedMessage = ` และอัปเดตต้นทุนให้ออเดอร์เก่า ${syncResult.affectedSalesCount} รายการ`;
        }
      } catch (err) {
        console.warn("Failed to sync historical sales costs for menu:", err);
        syncedMessage = " แต่คำนวณบิลย้อนหลังไม่สำเร็จ กรุณาลองใหม่จากหน้ารายงาน";
      }
    }

    revalidateMenus();
    return { ok: true, message: `บันทึกสูตรและคำนวณต้นทุนใหม่แล้ว${syncedMessage}` };
  });
}

export async function setMenuAvailability(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, shopId }) => {
    const menuId = id(form);
    const available = form.get("available") === "true";
    const { data: existingMenu } = await supabase.from("menus").select("id,name").eq("id", menuId).maybeSingle();
    if (!existingMenu || !matchesShopText(String((existingMenu as Row).name ?? ""), shopId)) {
      throw new InputError("ไม่พบเมนูในร้านปัจจุบัน");
    }
    const { error } = await supabase.from("menus").update({ is_available: available, updated_at: new Date().toISOString() }).eq("id", menuId);
    if (error) dbError(error);
    revalidateMenus();
  });
}

export async function deleteMenu(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, shopId }) => {
    const menuId = id(form);
    const { data: existingMenu } = await supabase.from("menus").select("id,name").eq("id", menuId).maybeSingle();
    if (!existingMenu || !matchesShopText(String((existingMenu as Row).name ?? ""), shopId)) {
      throw new InputError("ไม่พบเมนูในร้านปัจจุบัน");
    }
    const { error } = await supabase.from("menus").delete().eq("id", menuId);
    if (error) dbError(error, { foreignKey: "เมนูนี้มีประวัติการขายแล้ว จึงลบไม่ได้ — ใช้ “ปิดการขาย” แทน" });
    revalidateMenus();
  });
}
