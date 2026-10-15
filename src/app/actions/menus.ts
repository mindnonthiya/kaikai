"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { ADDON_CATEGORY, DISH_CATEGORY, SERVICE_CATEGORY } from "@/lib/data/types";
import { recalculateMenuCosts } from "@/lib/menu-cost";
import { InputError, amountOrZero, dbError, id, money, oneOf, runAction, text } from "@/lib/server-action";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f-]{36}$/i;

function revalidateMenus() {
  revalidatePath("/menus");
  revalidatePath("/sales/new");
  revalidatePath("/dashboard");
}

export async function saveMenu(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const menuId = String(form.get("id") ?? "") || null;
    const name = text(form, "name", "ชื่อเมนู", { max: 120 });
    const category = oneOf(form, "category", [DISH_CATEGORY, ADDON_CATEGORY, SERVICE_CATEGORY] as const, "ประเภทเมนู");
    const price = money(form, "price", "ราคาขาย", { required: true, positive: true });
    const removeImage = form.get("remove_image") === "true";
    const imageFile = form.get("image") as File | null;

    const fields: Record<string, unknown> = {
      name,
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
      const { error } = await supabase.from("menus").update(fields).eq("id", menuId);
      if (error) dbError(error, unique);
    } else {
      const { data, error } = await supabase.from("menus")
        .insert({ ...fields, owner_id: user.id, current_cost_satang: 0, is_available: true })
        .select("id").single();
      if (error) dbError(error, unique);
      savedId = String((data as Row).id);
      // A new dish starts with 1 of every per-order packaging item (box, spoon, sauce cup); add-ons start empty.
      if (category === DISH_CATEGORY) {
        const { data: packs, error: packError } = await supabase.from("packaging_items").select("id").eq("is_active", true).eq("per_order", true);
        if (packError) dbError(packError);
        const recipe = (packs as Row[]).map((p) => ({ owner_id: user.id, menu_id: savedId, packaging_item_id: String(p.id), quantity: 1 }));
        if (recipe.length) {
          const { error: recipeError } = await supabase.from("menu_recipe_items").insert(recipe);
          if (recipeError) dbError(recipeError);
        }
      }
    }
    await recalculateMenuCosts(supabase, [savedId!]);
    revalidateMenus();
    return { ok: true, message: menuId ? "บันทึกการแก้ไขแล้ว" : `เพิ่มเมนู “${name}” แล้ว` };
  });
}

/**
 * Saves a whole recipe at once from stepper fields `pack_<id>` (packaging) and `ing_<id>` (per-piece ingredients).
 * Only items present in the form are replaced; 0 removes the item from the recipe.
 */
export async function saveMenuRecipe(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase, user }) => {
    const menuId = id(form, "menu_id");
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
    await recalculateMenuCosts(supabase, [menuId]);
    revalidateMenus();
    return { ok: true, message: "บันทึกสูตรและคำนวณต้นทุนใหม่แล้ว" };
  });
}

export async function setMenuAvailability(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const menuId = id(form);
    const available = form.get("available") === "true";
    const { error } = await supabase.from("menus").update({ is_available: available, updated_at: new Date().toISOString() }).eq("id", menuId);
    if (error) dbError(error);
    revalidateMenus();
  });
}

export async function deleteMenu(form: FormData): Promise<ActionState> {
  return runAction(async ({ supabase }) => {
    const menuId = id(form);
    const { error } = await supabase.from("menus").delete().eq("id", menuId);
    if (error) dbError(error, { foreignKey: "เมนูนี้มีประวัติการขายแล้ว จึงลบไม่ได้ — ใช้ “ปิดการขาย” แทน" });
    revalidateMenus();
  });
}
