// Shapes the pages work with. Supabase rows are mapped into these in ./queries.ts,
// and demo mode builds the same shapes in ./demo.ts — so every page has one code path.

export type PaymentMethod = "cash" | "transfer" | "other";
export type PaymentStatus = "unpaid" | "partial" | "paid" | "refunded";
export type SaleStatus = "draft" | "confirmed" | "cancelled" | "refunded";
export type ExpenseKind = "direct" | "operating" | "one_time" | "recurring";

export type SaleItemRecord = { menuId: string; name: string; quantity: number; revenue: number; cost: number };
export type PaymentRecord = { method: PaymentMethod; amount: number };

export type SaleRecord = {
  id: string;
  saleNumber: number;
  soldAt: string;
  status: SaleStatus;
  paymentStatus: PaymentStatus;
  customerName: string | null;
  notes: string | null;
  productRevenue: number;
  discount: number;
  delivery: number;
  fee: number;
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
  /** Total cost per box = material (ingredients + packaging) + labor + overhead. */
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

export type PackagingRecord = { id: string; name: string; unit: string; unitCost: number; isActive: boolean };

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
