import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHOP_ID,
  decodeShopText,
  encodeSaleNotesForShop,
  encodeShopText,
  matchesSaleShop,
  matchesShopText,
  normalizeShopId,
  resolveInventoryShopId,
  scopedSettingsKey,
  stripShopPrefix,
} from "./shop-scope";

describe("shop-scope helpers", () => {
  it("normalizes empty or invalid shop IDs to default", () => {
    expect(normalizeShopId(null)).toBe(DEFAULT_SHOP_ID);
    expect(normalizeShopId("")).toBe(DEFAULT_SHOP_ID);
    expect(normalizeShopId("default")).toBe(DEFAULT_SHOP_ID);
    expect(normalizeShopId("s_1234abcd")).toBe("s_1234abcd");
    expect(normalizeShopId("bad id with spaces")).toBe(DEFAULT_SHOP_ID);
  });

  it("encodes and decodes shop text cleanly without double prefixing", () => {
    expect(encodeShopText("เครปกล้วยหอม", "default")).toBe("เครปกล้วยหอม");
    expect(encodeShopText("เครปกล้วยหอม", "s_branch2")).toBe("[s:s_branch2]เครปกล้วยหอม");
    expect(encodeShopText("[s:old]เครปกล้วยหอม", "s_branch2")).toBe("[s:s_branch2]เครปกล้วยหอม");

    expect(decodeShopText("เครปกล้วยหอม")).toEqual({
      shopId: "default",
      text: "เครปกล้วยหอม",
    });
    expect(decodeShopText("[s:s_branch2]เครปกล้วยหอม")).toEqual({
      shopId: "s_branch2",
      text: "เครปกล้วยหอม",
    });
    expect(stripShopPrefix("[s:s_branch2]เครปกล้วยหอม")).toBe("เครปกล้วยหอม");
  });

  it("matches shop text and sale rows accurately", () => {
    expect(matchesShopText("ไข่ไก่", "default")).toBe(true);
    expect(matchesShopText("ไข่ไก่", "s_2")).toBe(false);
    expect(matchesShopText("[s:s_2]ไข่ไก่", "s_2")).toBe(true);

    expect(encodeSaleNotesForShop(null, "default")).toBeNull();
    expect(encodeSaleNotesForShop(null, "s_2")).toBe("[s:s_2]");
    expect(encodeSaleNotesForShop("ลูกค้าประจำ", "s_2")).toBe("[s:s_2]ลูกค้าประจำ");

    expect(matchesSaleShop({ notes: "[s:s_2]ลูกค้าประจำ" }, "s_2")).toBe(true);
    expect(matchesSaleShop({ notes: "[s:s_2]" }, "default")).toBe(false);
    expect(
      matchesSaleShop(
        { notes: null, sale_items: [{ menu_name_snapshot: "[s:s_2]ชาไทย" }] },
        "s_2",
      ),
    ).toBe(true);
  });

  it("builds scoped settings keys", () => {
    expect(scopedSettingsKey("sales", "default")).toBe("sales");
    expect(scopedSettingsKey("sales", "s_2")).toBe("s:s_2:sales");
    expect(scopedSettingsKey("profile", "s_2")).toBe("s:s_2:profile");
  });

  it("resolves shared inventory shop ID safely including chains and cycles", () => {
    const shops = [
      { id: "s_b", sharedIngredientsFromShopId: "default" },
      { id: "s_c", sharedIngredientsFromShopId: "s_b" },
      { id: "s_isolated", sharedIngredientsFromShopId: null },
      { id: "s_cycle1", sharedIngredientsFromShopId: "s_cycle2" },
      { id: "s_cycle2", sharedIngredientsFromShopId: "s_cycle1" },
      { id: "s_missing", sharedIngredientsFromShopId: "s_nonexistent" },
    ];

    expect(resolveInventoryShopId("default", shops)).toBe("default");
    expect(resolveInventoryShopId("s_b", shops)).toBe("default");
    expect(resolveInventoryShopId("s_c", shops)).toBe("default");
    expect(resolveInventoryShopId("s_isolated", shops)).toBe("s_isolated");
    expect(resolveInventoryShopId("s_cycle1", shops)).toBe("s_cycle2");
    expect(resolveInventoryShopId("s_missing", shops)).toBe("s_missing");
  });
});
