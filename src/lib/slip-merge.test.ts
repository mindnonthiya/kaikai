import { describe, expect, it } from "vitest";
import type { PricePreset } from "@/lib/data/types";
import { matchPresetStrictly } from "@/lib/preset-matcher";
import {
  collectSlipReferenceNumbers,
  formatMultiSlipBreakdownNote,
  sumSlipAmountsSatang,
} from "./slip-merge";

describe("slip-merge helpers", () => {
  it("sums primary and extra slip satang amounts accurately", () => {
    expect(sumSlipAmountsSatang(6900, [{ amountSatang: 2000 }])).toBe(8900);
    expect(sumSlipAmountsSatang(5000, [{ amountSatang: 1900 }, { amountSatang: 1500 }])).toBe(8400);
    expect(sumSlipAmountsSatang(8400, [])).toBe(8400);
    expect(sumSlipAmountsSatang(-100, [{ amountSatang: -50 }, { amountSatang: 3000 }])).toBe(3000);
  });

  it("collects unique non-empty reference numbers in order", () => {
    expect(
      collectSlipReferenceNumbers("REF-001", [
        { referenceNumber: "REF-002" },
        { referenceNumber: "  REF-001 " },
        { referenceNumber: "" },
        { referenceNumber: undefined },
        { referenceNumber: "REF-003" },
      ])
    ).toEqual(["REF-001", "REF-002", "REF-003"]);

    expect(collectSlipReferenceNumbers(undefined, [])).toEqual([]);
  });

  it("formats multi-slip breakdown note only when extra slips exist", () => {
    expect(formatMultiSlipBreakdownNote(6900, [])).toBeNull();
    expect(formatMultiSlipBreakdownNote(6900, [{ amountSatang: 2000 }])).toBe(
      "รวม 2 สลิป (฿69 + ฿20 = ฿89)"
    );
    expect(
      formatMultiSlipBreakdownNote(5000, [{ amountSatang: 1900 }, { amountSatang: 1500 }])
    ).toBe("รวม 3 สลิป (฿50 + ฿19 + ฿15 = ฿84)");
    expect(formatMultiSlipBreakdownNote(6950, [{ amountSatang: 1950 }])).toBe(
      "รวม 2 สลิป (฿69.50 + ฿19.50 = ฿89)"
    );
  });

  it("re-matches strict price presets when a customer transfers remaining balance in a second slip", () => {
    const presets: PricePreset[] = [
      {
        id: "preset-69",
        name: "ข้าวมันไก่ 1 กล่อง (รับเอง)",
        amountSatang: 6900,
        fulfillment: "pickup",
        deliveryChargedSatang: 0,
        items: [{ menuId: "menu-1", quantity: 1 }],
      },
      {
        id: "preset-84",
        name: "ข้าวมันไก่ 1 กล่อง (ส่ง)",
        amountSatang: 8400,
        fulfillment: "delivery",
        deliveryChargedSatang: 1500,
        items: [{ menuId: "menu-1", quantity: 1 }],
      },
    ];

    // Customer initially transferred 69 baht (forgot 15 baht delivery fee)
    const initialMatch = matchPresetStrictly(6900, presets);
    expect(initialMatch?.id).toBe("preset-69");

    // Customer transfers an additional 15 baht slip -> combined 84 baht matches delivery preset
    const combinedSatang = sumSlipAmountsSatang(6900, [{ amountSatang: 1500 }]);
    expect(combinedSatang).toBe(8400);
    const mergedMatch = matchPresetStrictly(combinedSatang, presets);
    expect(mergedMatch?.id).toBe("preset-84");
    expect(mergedMatch?.fulfillment).toBe("delivery");
    expect(mergedMatch?.deliveryChargedSatang).toBe(1500);
  });
});
