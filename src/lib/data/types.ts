// Shapes the pages work with. Supabase rows are mapped into these in ./queries.ts.

export type PaymentMethod = "cash" | "transfer" | "other";
export type PaymentStatus = "unpaid" | "partial" | "paid" | "refunded";
export type SaleStatus = "draft" | "confirmed" | "cancelled" | "refunded";
export type ExpenseKind = "direct" | "operating" | "one_time" | "recurring";
export type Fulfillment = "pickup" | "delivery";

/** Menus in this category are add-ons (extra chicken, plain rice): small buttons when selling, not counted as boxes. */
export const ADDON_CATEGORY = "เพิ่มเติม";
export const isAddonCategory = (category: string | null | undefined) => (category ?? "").trim() === ADDON_CATEGORY;
/** Expense category used to compare delivery income with fuel. */
export const FUEL_CATEGORY = "ค่าน้ำมัน";

export type SaleItemRecord = { menuId: string; name: string; category: string | null; quantity: number; revenue: number; cost: number };
export type PaymentRecord = { method: PaymentMethod; amount: number };

export type SaleRecord = {
  id: string;
  saleNumber: number;
  soldAt: string;
  status: SaleStatus;
  paymentStatus: PaymentStatus;
  customerName: string | null;
  notes: string | null;
  fulfillment: Fulfillment;
  productRevenue: number;
  discount: number;
  delivery: number;
  fee: number;
  /** Packaging actually handed out with this order (part of cogs). */
  packagingCost: number;
  netRevenue: number;
  cogs: number;
  grossProfit: number;
  items: SaleItemRecord[];
  payments: PaymentRecord[];
};

export type ExpenseRecord = {
  id: string;
  spentAt: string;
  category: string;
  kind: ExpenseKind;
  amount: number;
  description: string;
  payee: string | null;
  paymentMethod: PaymentMethod | null;
};

export type MenuRecord = {
  id: string;
  name: string;
  category: string;
  price: number;
  laborCost: number;
  overheadCost: number;
  /** Food cost per dish typed in by the owner (added on top of recipe ingredients). */
  manualFoodCost: number;
  /** Default packaging cost per dish from the recipe (included in `cost`). */
  packagingCost: number;
  /** Total cost per dish = ingredients + manual food cost + packaging + labor + overhead. */
  cost: number;
  isAvailable: boolean;
  costCalculatedAt: string | null;
};

export type IngredientRecord = {
  id: string;
  name: string;
  category: string;
  baseUnit: string;
  /** Satang per base unit; may be fractional (e.g. 9.4 satang per gram). */
  unitCost: number;
  isActive: boolean;
};

export type PackagingRecord = {
  id: string;
  name: string;
  unit: string;
  /** Satang per piece (weighted average of purchases); may be fractional. */
  unitCost: number;
  isActive: boolean;
  /** true = cost counted in each order; false = booked as an expense when bought. */
  perOrder: boolean;
};

export type PackagingPurchaseRecord = {
  id: string;
  packagingItemId: string;
  itemName: string;
  unit: string;
  purchasedAt: string;
  price: number;
  packQuantity: number;
  vendor: string | null;
  /** Set when the purchase was also recorded as an expense. */
  expenseId: string | null;
};

export type SaleSettings = { defaultDeliveryFee: number };

export type PurchaseRecord = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  purchasedAt: string;
  price: number;
  purchasedQuantity: number;
  usableQuantity: number;
  unit: string;
  vendor: string | null;
};

export type RecipeItemRecord = {
  id: string;
  menuId: string;
  ingredientId: string | null;
  packagingItemId: string | null;
  quantity: number;
};

export type ProfileRecord = { displayName: string; shopName: string; email: string | null };

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { cash: "เงินสด", transfer: "เงินโอน", other: "อื่น ๆ" };
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = { paid: "ชำระแล้ว", partial: "ชำระบางส่วน", unpaid: "ค้างชำระ", refunded: "คืนเงินแล้ว" };
export const EXPENSE_KIND_LABELS: Record<ExpenseKind, string> = { direct: "ต้นทุนโดยตรง", operating: "ดำเนินงาน", one_time: "ครั้งเดียว", recurring: "ประจำ" };
export const FULFILLMENT_LABELS: Record<Fulfillment, string> = { pickup: "รับเอง", delivery: "ส่ง" };
