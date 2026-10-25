import { FUEL_CATEGORY, isAddonCategory, type ExpenseRecord, type MenuRecord, type RecipeItemRecord, type SaleRecord } from "@/lib/data/types";
import { DAY_MS, bangkokDayKey, formatThaiShortDate, formatThaiWeekday, isWithin } from "@/lib/time";

/** Only confirmed sales count toward revenue and profit. Cancelled/refunded/draft are excluded. */
export const countsAsRevenue = (sale: SaleRecord) => sale.status === "confirmed";

/**
 * "direct" expenses (e.g. buying boxes or ingredients) are already inside each menu's cost,
 * so they are NOT subtracted again from profit. Everything else is an operating expense.
 */
export const isOperatingExpense = (expense: ExpenseRecord) => expense.kind !== "direct";

export function filterSales(sales: SaleRecord[], start: Date, end: Date) {
  return sales.filter((sale) => isWithin(sale.soldAt, start, end));
}

export function filterExpenses(expenses: ExpenseRecord[], start: Date, end: Date) {
  return expenses.filter((expense) => isWithin(expense.spentAt, start, end));
}

export type Summary = {
  saleCount: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  operatingExpenses: number;
  directExpenses: number;
  netProfit: number;
  /** Dishes sold, not counting add-ons such as extra chicken or plain rice. */
  boxes: number;
  addons: number;
  averageProfitPerBox: number;
  /** Net profit ÷ revenue in basis points (3720 = 37.2%). */
  netMarginBps: number;
  grossMarginBps: number;
  payments: { cash: number; transfer: number; other: number };
  outstanding: number;
  /** Expenses broken down by payment method. */
  expensePayments: { cash: number; transfer: number; other: number };
  /** Net bank transfer flow (transfer sales − transfer expenses). */
  netTransfer: number;
  /** Delivery fees charged to customers (kept by the shop). */
  deliveryIncome: number;
  deliveryCount: number;
  /** Tip / overtransferred amount from customers. */
  tipIncome: number;
  /** Expenses in the “ค่าน้ำมัน” category. */
  fuelExpenses: number;
  /** Packaging handed out with orders (already inside cogs). */
  packagingCost: number;
  /** Estimated ingredient cost of the orders (cogs − packaging). */
  foodCost: number;
};

export function summarize(sales: SaleRecord[], expenses: ExpenseRecord[]): Summary {
  const active = sales.filter(countsAsRevenue);
  let revenue = 0, cogs = 0, grossProfit = 0, boxes = 0, addons = 0, paid = 0, deliveryIncome = 0, deliveryCount = 0, tipIncome = 0, packagingCost = 0;
  const payments = { cash: 0, transfer: 0, other: 0 };
  for (const sale of active) {
    revenue += sale.netRevenue;
    cogs += sale.cogs;
    grossProfit += sale.grossProfit;
    deliveryIncome += sale.delivery;
    if (sale.fulfillment === "delivery") deliveryCount += 1;
    tipIncome += (sale.tip ?? 0);
    packagingCost += sale.packagingCost;
    for (const item of sale.items) {
      if (isAddonCategory(item.category)) addons += item.quantity;
      else boxes += item.quantity;
    }
    for (const payment of sale.payments) { payments[payment.method] += payment.amount; paid += payment.amount; }
  }
  let operatingExpenses = 0, directExpenses = 0, fuelExpenses = 0;
  const expensePayments = { cash: 0, transfer: 0, other: 0 };
  for (const expense of expenses) {
    if (isOperatingExpense(expense)) operatingExpenses += expense.amount;
    else directExpenses += expense.amount;
    if (expense.category.trim() === FUEL_CATEGORY) fuelExpenses += expense.amount;
    // Older auto-created purchase expenses have no payment method; the shop pays by bank transfer.
    const method = expense.paymentMethod ?? "transfer";
    if (method === "cash") expensePayments.cash += expense.amount;
    else if (method === "other") expensePayments.other += expense.amount;
    else expensePayments.transfer += expense.amount;
  }
  const netProfit = grossProfit - operatingExpenses;
  return {
    saleCount: active.length,
    revenue, cogs, grossProfit, operatingExpenses, directExpenses, netProfit, boxes, addons,
    averageProfitPerBox: boxes ? Math.round(grossProfit / boxes) : 0,
    netMarginBps: revenue ? Math.round((netProfit * 10_000) / revenue) : 0,
    grossMarginBps: revenue ? Math.round((grossProfit * 10_000) / revenue) : 0,
    payments,
    outstanding: Math.max(0, revenue - paid),
    expensePayments,
    netTransfer: payments.transfer - expensePayments.transfer,
    deliveryIncome, deliveryCount, tipIncome, fuelExpenses, packagingCost,
    foodCost: Math.max(0, cogs - packagingCost),
  };
}

/** Percentage change, or null when there is nothing to compare with. */
export function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) * 1000) / Math.abs(previous)) / 10;
}

export function formatChange(change: number | null, suffix: string) {
  if (change === null) return undefined;
  if (change === 0) return `เท่ากับ${suffix}`;
  return `${change > 0 ? "↑" : "↓"} ${Math.abs(change).toLocaleString("th-TH")}% จาก${suffix}`;
}

export function formatPercentBps(bps: number) {
  return `${(bps / 100).toLocaleString("th-TH", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

export type DayPoint = { key: string; label: string; shortDate: string; saleCount: number; revenue: number; grossProfit: number; operatingExpenses: number; netProfit: number };

/** One point per Bangkok calendar day from `start` for `days` days. */
export function dailySeries(sales: SaleRecord[], expenses: ExpenseRecord[], start: Date, days: number, todayKey?: string): DayPoint[] {
  const points = new Map<string, DayPoint>();
  for (let i = 0; i < days; i++) {
    const day = new Date(start.getTime() + i * DAY_MS);
    const key = bangkokDayKey(day);
    points.set(key, { key, label: key === todayKey ? "วันนี้" : formatThaiWeekday(day), shortDate: formatThaiShortDate(day), saleCount: 0, revenue: 0, grossProfit: 0, operatingExpenses: 0, netProfit: 0 });
  }
  for (const sale of sales) {
    if (!countsAsRevenue(sale)) continue;
    const point = points.get(bangkokDayKey(sale.soldAt));
    if (!point) continue;
    point.saleCount += 1;
    point.revenue += sale.netRevenue;
    point.grossProfit += sale.grossProfit;
  }
  for (const expense of expenses) {
    if (!isOperatingExpense(expense)) continue;
    const point = points.get(bangkokDayKey(expense.spentAt));
    if (point) point.operatingExpenses += expense.amount;
  }
  for (const point of points.values()) point.netProfit = point.grossProfit - point.operatingExpenses;
  return [...points.values()];
}

export type MenuRank = { menuId: string; name: string; isAddon: boolean; quantity: number; revenue: number; cost: number; profit: number; marginBps: number };

/** Uses the price/cost snapshots stored on each sale line, not today's menu price. */
export function menuRanking(sales: SaleRecord[]): MenuRank[] {
  const byMenu = new Map<string, MenuRank>();
  for (const sale of sales) {
    if (!countsAsRevenue(sale)) continue;
    for (const item of sale.items) {
      const row = byMenu.get(item.menuId) ?? { menuId: item.menuId, name: item.name, isAddon: isAddonCategory(item.category), quantity: 0, revenue: 0, cost: 0, profit: 0, marginBps: 0 };
      row.quantity += item.quantity;
      row.revenue += item.revenue;
      row.cost += item.cost;
      row.profit = row.revenue - row.cost;
      byMenu.set(item.menuId, row);
    }
  }
  return [...byMenu.values()]
    .map((row) => ({ ...row, marginBps: row.revenue ? Math.round((row.profit * 10_000) / row.revenue) : 0 }))
    .sort((a, b) => Number(a.isAddon) - Number(b.isAddon) || b.profit - a.profit);
}

export type CategoryTotal = { category: string; amount: number; count: number; shareBps: number };

export function expensesByCategory(expenses: ExpenseRecord[]): CategoryTotal[] {
  const byCategory = new Map<string, CategoryTotal>();
  let total = 0;
  for (const expense of expenses) {
    const row = byCategory.get(expense.category) ?? { category: expense.category, amount: 0, count: 0, shareBps: 0 };
    row.amount += expense.amount;
    row.count += 1;
    total += expense.amount;
    byCategory.set(expense.category, row);
  }
  return [...byCategory.values()]
    .map((row) => ({ ...row, shareBps: total ? Math.round((row.amount * 10_000) / total) : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Recipe cost of one dish split into ingredients and packaging, each rounded to whole satang.
 * Packaging ids missing from `packagingCost` (e.g. items not counted per order) are ignored.
 */
export function recipeCostParts(
  items: RecipeItemRecord[],
  ingredientCost: Map<string, number>,
  packagingCost: Map<string, number>,
) {
  let ingredients = 0, packaging = 0;
  for (const item of items) {
    if (item.ingredientId) {
      const unitCost = ingredientCost.get(item.ingredientId);
      if (unitCost !== undefined) ingredients += item.quantity * unitCost;
    } else if (item.packagingItemId) {
      const unitCost = packagingCost.get(item.packagingItemId);
      if (unitCost !== undefined) packaging += item.quantity * unitCost;
    }
  }
  return { ingredients: Math.round(ingredients), packaging: Math.round(packaging) };
}

/** Material cost of one dish from its recipe (ingredients + packaging), in whole satang. */
export function recipeMaterialCost(
  items: RecipeItemRecord[],
  ingredientCost: Map<string, number>,
  packagingCost: Map<string, number>,
) {
  const parts = recipeCostParts(items, ingredientCost, packagingCost);
  return parts.ingredients + parts.packaging;
}

type PackagingLine = { quantity: number; isAddon?: boolean; packaging: Array<{ packagingId: string; quantity: number }> };

/**
 * Packaging handed out with an order by default, rounded up to whole pieces.
 * Dishes add up; add-ons add up separately; each item uses the larger of the two (not the sum).
 * Example with 1 spoon per dish and per plain rice: 89 + rice×1 → 1 spoon, 89 + rice×2 → 2 spoons.
 * Add-ons have no box or sauce cup, so those still follow the number of dishes.
 * The seller can still adjust the numbers before saving.
 */
export function defaultOrderPackaging(lines: PackagingLine[]) {
  const dishes = new Map<string, number>();
  const addons = new Map<string, number>();
  for (const line of lines) {
    if (line.quantity <= 0) continue;
    const target = line.isAddon ? addons : dishes;
    for (const pack of line.packaging) target.set(pack.packagingId, (target.get(pack.packagingId) ?? 0) + pack.quantity * line.quantity);
  }
  const totals = new Map<string, number>();
  for (const id of new Set([...dishes.keys(), ...addons.keys()])) {
    totals.set(id, Math.max(Math.ceil((dishes.get(id) ?? 0) - 1e-9), Math.ceil((addons.get(id) ?? 0) - 1e-9)));
  }
  return totals;
}

/** Cost of packaging lines; each line is rounded to whole satang (same rule as the database). */
export function packagingLinesCost(lines: Array<{ unitCost: number; quantity: number }>) {
  return lines.reduce((sum, line) => sum + (line.quantity > 0 ? Math.round(line.unitCost * line.quantity) : 0), 0);
}

/** Days of history needed before the pooled-ingredient % is calculated from real data. */
export const POOLED_MIN_DAYS = 7;
/** Look-back window for prices and the pooled-ingredient %. */
export const COSTING_WINDOW_DAYS = 30;

/**
 * Other ingredients (rice, herbs, sauce) as basis points of food sales:
 * purchases ÷ food sales over the window. Uses the owner's starting guess until there is enough data.
 */
export function pooledIngredientBps(input: { pooledPurchases: number; foodRevenue: number; historyDays: number; initialBps: number }) {
  const { pooledPurchases, foodRevenue, historyDays, initialBps } = input;
  if (historyDays >= POOLED_MIN_DAYS && foodRevenue > 0 && pooledPurchases > 0) {
    return { bps: Math.min(10_000, Math.round((pooledPurchases * 10_000) / foodRevenue)), source: "actual" as const };
  }
  return { bps: initialBps, source: "initial" as const };
}

/** Pooled-ingredient cost of one item at the given rate, in whole satang (same rounding as create_sale). */
export const pooledCost = (price: number, bps: number) => Math.round((price * bps) / 10_000);

type QuantityPurchase = { purchasedAt: string; price: number; quantity: number | null };

/**
 * Weighted price per purchase unit (e.g. per กก.) over the 30 days up to the latest purchase.
 * Purchases without a quantity are ignored. Returns 0 when there is nothing to average.
 */
export function weightedPricePerUnit(purchases: QuantityPurchase[]) {
  const withQuantity = purchases.filter((p) => p.quantity && p.quantity > 0);
  if (!withQuantity.length) return 0;
  const latest = Math.max(...withQuantity.map((p) => Date.parse(p.purchasedAt)));
  const from = latest - COSTING_WINDOW_DAYS * DAY_MS;
  let price = 0, quantity = 0;
  for (const p of withQuantity) {
    if (Date.parse(p.purchasedAt) < from) continue;
    price += p.price;
    quantity += p.quantity!;
  }
  return quantity > 0 ? price / quantity : 0;
}

/**
 * Period used to learn "pieces per กก." from real data.
 * The shop buys when the previous stock runs out, so everything bought before the latest purchase
 * has been used by the time of that purchase: pieces sold in [start, end) came from `quantity` กก.
 * Needs at least 3 purchases spanning 7+ days (within 30 days) so one odd day does not skew it.
 */
export function yieldWindow(purchases: Array<{ purchasedAt: string; quantity: number | null }>) {
  const dated = purchases.filter((p) => p.quantity && p.quantity > 0).map((p) => ({ at: Date.parse(p.purchasedAt), quantity: p.quantity! }));
  if (dated.length < 3) return null;
  const end = Math.max(...dated.map((p) => p.at));
  const earlier = dated.filter((p) => p.at < end && p.at >= end - COSTING_WINDOW_DAYS * DAY_MS);
  if (earlier.length < 2) return null;
  const start = Math.min(...earlier.map((p) => p.at));
  if (end - start < POOLED_MIN_DAYS * DAY_MS) return null;
  return { start: new Date(start), end: new Date(end), quantity: earlier.reduce((sum, p) => sum + p.quantity, 0) };
}

/**
 * Pieces per purchase unit learned from sales, rounded to 0.1.
 * Ignored (null) when it is less than half or more than double the current value — usually a missed purchase entry.
 */
export function learnedYield(piecesSold: number, quantityBought: number, current: number) {
  if (piecesSold <= 0 || quantityBought <= 0) return null;
  const value = Math.round((piecesSold / quantityBought) * 10) / 10;
  if (value < current * 0.5 || value > current * 2) return null;
  return value;
}

/** Menus whose cost is missing or whose margin is thin enough to warn the owner. Pooled ingredients are added at `pooledBps`. */
export function menuCostWarnings(menus: MenuRecord[], minMarginBps = 2000, pooledBps = 0) {
  return menus
    .filter((menu) => menu.isAvailable)
    .map((menu) => {
      const cost = menu.cost + pooledCost(menu.price, pooledBps);
      return { menu, marginBps: menu.price ? Math.round(((menu.price - cost) * 10_000) / menu.price) : 0 };
    })
    .filter(({ menu, marginBps }) => menu.cost === 0 || marginBps < minMarginBps);
}
