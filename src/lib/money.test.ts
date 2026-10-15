import { describe, expect, it } from "vitest";
import { bahtToSatang, calculateLine, calculateNetProfit, calculateSale, formatBaht, weightedAverageCost } from "./money";

describe("money utilities", () => {
  it("converts baht without floating point drift", () => { expect(bahtToSatang("60.25")).toBe(6025); expect(bahtToSatang("0.10")).toBe(10); expect(() => bahtToSatang("1.999")).toThrow(); });
  it("formats satang", () => { expect(formatBaht(6000)).toContain("60"); expect(formatBaht(6025)).toContain("60.25"); expect(formatBaht(-42720)).toBe("-฿427.20"); });
  it("calculates weighted average unit cost", () => { expect(weightedAverageCost([{ totalCost: 45000, usableQuantity: 5000 }, { totalCost: 50000, usableQuantity: 5000 }])).toBe(10); });
  it("calculates line cost and gross profit", () => { expect(calculateLine(6000, 3275, 2)).toEqual({ revenue: 12000, cost: 6550, grossProfit: 5450 }); });
  it("supports multiple menus, discounts, delivery and fees", () => { expect(calculateSale({ items: [{ unitPrice: 6000, unitCost: 3000, quantity: 2 }, { unitPrice: 7500, unitCost: 4000, quantity: 1 }], discount: 500, deliveryCharged: 1000, paymentFee: 300 })).toMatchObject({ productRevenue: 19500, netRevenue: 19700, cogs: 10000, grossProfit: 9700, boxes: 3 }); });
  it("calculates net profit", () => { expect(calculateNetProfit(9700, 2000)).toBe(7700); });
  it("adds order packaging to cost and keeps the delivery fee as revenue", () => {
    // 69฿ dish (food cost 30฿) delivered for 15฿, with box 2.60 + spoon 1.60 + sauce cup 0.50.
    expect(calculateSale({ items: [{ unitPrice: 6900, unitCost: 3000, quantity: 1 }], deliveryCharged: 1500, packagingCost: 470 }))
      .toMatchObject({ netRevenue: 8400, cogs: 3470, grossProfit: 4930 });
    expect(() => calculateSale({ items: [{ unitPrice: 6900, unitCost: 3000, quantity: 1 }], packagingCost: -1 })).toThrow();
  });
  it("adds tip/overtransferred amount to net revenue and gross profit", () => {
    expect(calculateSale({ items: [{ unitPrice: 6000, unitCost: 3000, quantity: 1 }], deliveryCharged: 1500, tip: 1000 }))
      .toMatchObject({ productRevenue: 6000, netRevenue: 8500, cogs: 3000, grossProfit: 5500 });
  });
  it("guards invalid values and division by zero", () => { expect(() => calculateSale({ items: [] })).toThrow(); expect(() => calculateLine(100, 50, 0)).toThrow(); });
  it("keeps old sale snapshots independent from changed menu cost", () => { const snapshot = calculateLine(6000, 3000, 1); calculateLine(6000, 4000, 1); expect(snapshot.cost).toBe(3000); });
});
