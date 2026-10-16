import { describe, expect, it } from "vitest";
import { matchPresetStrictly } from "./preset-matcher";
import type { PricePreset } from "./data/types";

describe("matchPresetStrictly", () => {
  const presets: PricePreset[] = [
    {
      id: "p1",
      name: "ชุด 84 บาท",
      amountSatang: 8400,
      fulfillment: "delivery",
      deliveryChargedSatang: 1500,
      items: [{ menuId: "m1", quantity: 1 }],
    },
    {
      id: "p2",
      name: "ไก่ต้มกับข้าว 2 กล่อง + ส่ง",
      amountSatang: 19300,
      fulfillment: "delivery",
      deliveryChargedSatang: 1500,
      items: [{ menuId: "m2", quantity: 2 }],
    },
  ];

  it("strictly matches preset with exact amount", () => {
    const match = matchPresetStrictly(8400, presets);
    expect(match).not.toBeNull();
    expect(match?.id).toBe("p1");
    expect(match?.name).toBe("ชุด 84 บาท");
  });

  it("does NOT fuzzy match 17800 against 19300 even if 19300 - 1500 = 17800", () => {
    // Crucial requirement: 178 baht should NEVER be substituted with a 193 baht preset
    const match = matchPresetStrictly(17800, presets);
    expect(match).toBeNull();
  });

  it("returns null for non-positive or 0 amounts", () => {
    expect(matchPresetStrictly(0, presets)).toBeNull();
    expect(matchPresetStrictly(-100, presets)).toBeNull();
  });

  it("matches new preset if added with 17800", () => {
    const updatedPresets: PricePreset[] = [
      ...presets,
      {
        id: "p3",
        name: "ไก่ต้มน้ำปลา 2 กล่อง",
        amountSatang: 17800,
        fulfillment: "pickup",
        deliveryChargedSatang: 0,
        items: [{ menuId: "m2", quantity: 2 }],
      },
    ];

    const match = matchPresetStrictly(17800, updatedPresets);
    expect(match).not.toBeNull();
    expect(match?.id).toBe("p3");
    expect(match?.amountSatang).toBe(17800);
  });
});
