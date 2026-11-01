import { describe, expect, it } from "vitest";
import {
  computeItemizedSummary,
  createInitialItemizedState,
} from "./slip-itemized-picker";

const samplePerUnit = [
  {
    id: "ing-chicken",
    name: "ไก่",
    purchaseUnit: "กก.",
    baseUnit: "ชิ้น",
    unitsPerPurchaseUnit: 25.6,
    unitPrice: "115.00",
  },
];

const samplePooled = [
  { id: "ing-chili", name: "พริก" },
  { id: "ing-garlic", name: "กระเทียม" },
  { id: "ing-sauce", name: "น้ำปลา" },
];

const samplePackaging = [
  {
    id: "pack-box",
    name: "กล่อง",
    unit: "ชิ้น",
    perOrder: true,
    packPrice: "65.00",
    perPack: "25",
  },
];

describe("SlipItemizedPicker calculations", () => {
  it("does not treat an old unit price as the price and size of a new pack", () => {
    const withoutHistory = [{ ...samplePackaging[0], packPrice: "", perPack: "" }];
    const state = createInitialItemizedState([], withoutHistory);
    state.packaging["pack-box"] = { packs: 1, priceBaht: "65", perPack: "" };
    expect(computeItemizedSummary(state, [], [], withoutHistory).packagingItems).toEqual([]);

    state.packaging["pack-box"].perPack = "25";
    const result = computeItemizedSummary(state, [], [], withoutHistory);
    expect(result.packagingItems).toEqual([{ packagingId: "pack-box", packs: 1, packPriceSatang: 6500, perPackQuantity: 25 }]);
    expect(result.totalSatang).toBe(6500);
    expect(result.packagingItems[0].packPriceSatang / result.packagingItems[0].perPackQuantity).toBe(260);
  });

  it("computes total satang and breakdown across per-unit, pooled, packaging, and extra expenses", () => {
    const state = createInitialItemizedState(samplePerUnit, samplePackaging);

    // 2 kg of chicken @ 115 THB = 230 THB (23000 satang)
    state.perUnitQty["ing-chicken"] = "2";
    // Chili 40 THB, Garlic 55 THB
    state.pooledAmount["ing-chili"] = "40";
    state.pooledAmount["ing-garlic"] = "55";
    // 1 pack of boxes @ 65 THB
    state.packaging["pack-box"].packs = 1;
    // Extra expense: Ice 20 THB
    state.extras.push({
      id: "ex-1",
      description: "น้ำแข็ง",
      category: "อื่น ๆ",
      kind: "operating",
      amountBaht: "20",
    });

    const summary = computeItemizedSummary(
      state,
      samplePerUnit,
      samplePooled,
      samplePackaging
    );

    // 230 + 40 + 55 + 65 + 20 = 410 THB = 41000 satang
    expect(summary.totalSatang).toBe(41000);
    expect(summary.itemCount).toBe(5);
    expect(summary.ingredientCount).toBe(3);
    expect(summary.packagingCount).toBe(1);
    expect(summary.extraCount).toBe(1);
    expect(summary.perUnitItems).toEqual([
      { ingredientId: "ing-chicken", quantity: 2, unitPriceSatang: 11500 },
    ]);
    expect(summary.pooledItems).toEqual([
      { ingredientId: "ing-chili", amountSatang: 4000 },
      { ingredientId: "ing-garlic", amountSatang: 5500 },
    ]);
    expect(summary.packagingItems).toEqual([
      {
        packagingId: "pack-box",
        packs: 1,
        packPriceSatang: 6500,
        perPackQuantity: 25,
      },
    ]);
  });
});
