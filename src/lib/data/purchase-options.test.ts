import { describe, expect, it, vi } from "vitest";
vi.mock("./queries", () => ({}));
import { resolvePackagingDefaultPack } from "./purchase-options";
import type { PackagingPurchaseRecord, PackagingRecord } from "./types";

const item = { id: "p", name: "กล่อง", unitCost: 1500 } as PackagingRecord;
describe("packaging purchase defaults", () => {
  it("preserves a legitimate single piece priced above ten baht", () => {
    const purchase = { price: 1500, packCount: 1, packQuantity: 1 } as PackagingPurchaseRecord;
    expect(resolvePackagingDefaultPack(item, purchase)).toEqual({ packPrice: "15.00", perPack: "1" });
  });
  it("requires pack inputs when purchase history is gone even if a unit price remains", () => {
    expect(resolvePackagingDefaultPack(item)).toEqual({ packPrice: "", perPack: "" });
    expect(resolvePackagingDefaultPack({ ...item, unitCost: 260 })).toEqual({ packPrice: "", perPack: "" });
  });
  it("keeps quantities explicitly recorded for multiple packs", () => {
    const purchase = { price: 13000, packCount: 2, packQuantity: 100 } as PackagingPurchaseRecord;
    expect(resolvePackagingDefaultPack(item, purchase)).toEqual({ packPrice: "65.00", perPack: "50" });
  });
  it("leaves missing purchase information empty for the seller to enter", () => {
    expect(resolvePackagingDefaultPack({ ...item, unitCost: 0 })).toEqual({ packPrice: "", perPack: "" });
  });
});
