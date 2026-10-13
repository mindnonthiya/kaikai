// Sample data shown when Supabase environment variables are not set.
// Dates are generated relative to "now" so the dashboard always has something for today,
// and a seeded generator keeps the numbers stable between page loads.
import type { ExpenseRecord, IngredientRecord, MenuRecord, PackagingRecord, PaymentMethod, ProfileRecord, PurchaseRecord, RecipeItemRecord, SaleRecord } from "./types";
import { DAY_MS, startOfBangkokDay } from "@/lib/time";

export const demoProfile: ProfileRecord = { displayName: "เจ้าของร้าน", shopName: "kaikai ข้าวไก่ต้มน้ำปลา", email: "owner@kaikai.local" };

export const demoMenus: MenuRecord[] = [
  { id: "41111111-1111-4111-8111-111111111111", name: "ข้าวไก่ต้มน้ำปลา", category: "เมนูหลัก", price: 6000, laborCost: 500, overheadCost: 250, cost: 3275, isAvailable: true, costCalculatedAt: null },
  { id: "41111111-1111-4111-8111-111111111112", name: "ข้าวไก่ต้มน้ำปลาพิเศษ", category: "เมนูหลัก", price: 7500, laborCost: 600, overheadCost: 300, cost: 4120, isAvailable: true, costCalculatedAt: null },
  { id: "41111111-1111-4111-8111-111111111113", name: "ไก่ต้มน้ำปลา (กับข้าว)", category: "กับข้าว", price: 9000, laborCost: 650, overheadCost: 300, cost: 4950, isAvailable: true, costCalculatedAt: null },
  { id: "41111111-1111-4111-8111-111111111114", name: "ข้าวเปล่า", category: "เพิ่มเติม", price: 1500, laborCost: 150, overheadCost: 100, cost: 620, isAvailable: true, costCalculatedAt: null },
];

export const demoIngredients: IngredientRecord[] = [
  { id: "21111111-1111-4111-8111-111111111111", name: "ไก่สะโพก", category: "เนื้อสัตว์", baseUnit: "กรัม", unitCost: 9.4, isActive: true },
  { id: "21111111-1111-4111-8111-111111111112", name: "ข้าวหอมมะลิ", category: "วัตถุดิบหลัก", baseUnit: "กรัม", unitCost: 4.85, isActive: true },
  { id: "21111111-1111-4111-8111-111111111113", name: "น้ำปลาและเครื่องปรุง", category: "เครื่องปรุง", baseUnit: "มิลลิลิตร", unitCost: 6.2, isActive: true },
];

export const demoPackaging: PackagingRecord[] = [
  { id: "31111111-1111-4111-8111-111111111111", name: "กล่องอาหาร", unit: "ชิ้น", unitCost: 450, isActive: true },
  { id: "31111111-1111-4111-8111-111111111112", name: "ช้อนและส้อม", unit: "ชุด", unitCost: 180, isActive: true },
  { id: "31111111-1111-4111-8111-111111111113", name: "ถุงหิ้ว", unit: "ใบ", unitCost: 70, isActive: true },
];

export const demoRecipeItems: RecipeItemRecord[] = [];

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const customers = ["ลูกค้าหน้าร้าน", "คุณเมย์", "คุณบี", "ออฟฟิศ A", "คุณต้น", null, null];

export function demoSales(now = new Date()): SaleRecord[] {
  const today = startOfBangkokDay(now);
  const sales: SaleRecord[] = [];
  let saleNumber = 1000;
  for (let dayOffset = 70; dayOffset >= 0; dayOffset--) {
    const dayStart = new Date(today.getTime() - dayOffset * DAY_MS);
    const random = seeded(Math.floor(dayStart.getTime() / DAY_MS));
    const count = 6 + Math.floor(random() * 9);
    for (let i = 0; i < count; i++) {
      // 08:00–19:59 Bangkok
      const soldAt = new Date(dayStart.getTime() + (8 + random() * 12) * 60 * 60 * 1000);
      if (soldAt > now) continue;
      const lines = new Map<string, number>();
      const lineCount = 1 + Math.floor(random() * 2);
      for (let l = 0; l < lineCount; l++) {
        const menu = demoMenus[Math.floor(random() * demoMenus.length)];
        lines.set(menu.id, (lines.get(menu.id) ?? 0) + 1 + Math.floor(random() * 3));
      }
      const items = [...lines.entries()].map(([menuId, quantity]) => {
        const menu = demoMenus.find((m) => m.id === menuId)!;
        return { menuId, name: menu.name, quantity, revenue: menu.price * quantity, cost: menu.cost * quantity };
      });
      const productRevenue = items.reduce((sum, item) => sum + item.revenue, 0);
      const cogs = items.reduce((sum, item) => sum + item.cost, 0);
      const method: PaymentMethod = random() < 0.7 ? "transfer" : "cash";
      const status = random() < 0.03 ? "cancelled" : "confirmed";
      const unpaid = status === "confirmed" && random() < 0.05;
      saleNumber += 1;
      sales.push({
        id: `demo-${saleNumber}`, saleNumber, soldAt: soldAt.toISOString(), status, paymentStatus: unpaid ? "unpaid" : "paid",
        customerName: customers[Math.floor(random() * customers.length)], notes: null,
        productRevenue, discount: 0, delivery: 0, fee: 0, netRevenue: productRevenue, cogs, grossProfit: productRevenue - cogs,
        items, payments: unpaid ? [] : [{ method, amount: productRevenue }],
      });
    }
  }
  return sales.sort((a, b) => b.soldAt.localeCompare(a.soldAt));
}

export function demoExpenses(now = new Date()): ExpenseRecord[] {
  const today = startOfBangkokDay(now);
  const at = (daysAgo: number, hour: number) => new Date(today.getTime() - daysAgo * DAY_MS + hour * 60 * 60 * 1000).toISOString();
  const expenses: ExpenseRecord[] = [];
  for (let week = 0; week < 10; week++) {
    const d = week * 7;
    expenses.push(
      { id: `demo-gas-${week}`, spentAt: at(d + 2, 9), category: "ค่าแก๊ส", kind: "operating", amount: 92000, description: "ถังแก๊ส 2 ถัง", payee: "ร้านแก๊สเจริญ", paymentMethod: "cash" },
      { id: `demo-box-${week}`, spentAt: at(d + 1, 10), category: "บรรจุภัณฑ์", kind: "direct", amount: 67500, description: "กล่องอาหาร 150 ใบ", payee: "Pack Pro", paymentMethod: "transfer" },
      { id: `demo-ship-${week}`, spentAt: at(d + 3, 11), category: "ค่าขนส่ง", kind: "operating", amount: 8500, description: "ค่าขนส่งวัตถุดิบ", payee: "Grab", paymentMethod: "cash" },
    );
  }
  for (let month = 0; month < 3; month++) {
    expenses.push({ id: `demo-ads-${month}`, spentAt: at(month * 30 + 2, 14), category: "การตลาด", kind: "recurring", amount: 50000, description: "ค่าโฆษณา Facebook", payee: "Meta", paymentMethod: "other" });
  }
  return expenses.filter((e) => new Date(e.spentAt) <= now).sort((a, b) => b.spentAt.localeCompare(a.spentAt));
}

export function demoPurchases(now = new Date()): PurchaseRecord[] {
  const today = startOfBangkokDay(now);
  return [
    { id: "demo-p1", ingredientId: demoIngredients[0].id, ingredientName: "ไก่สะโพก", purchasedAt: new Date(today.getTime() - 1 * DAY_MS).toISOString(), price: 94000, purchasedQuantity: 10000, usableQuantity: 10000, unit: "กรัม", vendor: "ตลาดสด" },
    { id: "demo-p2", ingredientId: demoIngredients[1].id, ingredientName: "ข้าวหอมมะลิ", purchasedAt: new Date(today.getTime() - 3 * DAY_MS).toISOString(), price: 72750, purchasedQuantity: 15000, usableQuantity: 15000, unit: "กรัม", vendor: "แม็คโคร" },
    { id: "demo-p3", ingredientId: demoIngredients[2].id, ingredientName: "น้ำปลาและเครื่องปรุง", purchasedAt: new Date(today.getTime() - 5 * DAY_MS).toISOString(), price: 6200, purchasedQuantity: 1000, usableQuantity: 1000, unit: "มิลลิลิตร", vendor: "แม็คโคร" },
  ];
}
