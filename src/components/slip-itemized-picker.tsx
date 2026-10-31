"use client";

import { useState } from "react";
import { Box, CheckCircle2, Plus, ShoppingBasket, Sparkles, Trash2, WalletCards } from "lucide-react";
import type { PerUnitPurchaseItem, PooledPurchaseItem } from "@/components/ingredient-purchase-table";
import type { RestockItem } from "@/components/packaging-restock-table";
import { EXPENSE_KIND_LABELS, FUEL_CATEGORY, type ExpenseKind } from "@/lib/data/types";
import { formatBaht, formatUnitCost, satangToBahtInput, tryBahtToSatang } from "@/lib/money";

export type ExtraExpenseDraft = {
  id: string;
  description: string;
  category: string;
  kind: ExpenseKind;
  amountBaht: string;
};

export type PackagingRowDraft = {
  packs: number;
  priceBaht: string;
  perPack: string;
};

export type ItemizedSelectionState = {
  perUnitQty: Record<string, string>; // ingredientId -> qty string (e.g. "2" or "1.5")
  perUnitPrice: Record<string, string>; // ingredientId -> baht string
  pooledAmount: Record<string, string>; // ingredientId -> baht string
  packaging: Record<string, PackagingRowDraft>; // packagingId -> { packs, priceBaht, perPack }
  extras: ExtraExpenseDraft[];
};

export function createInitialItemizedState(
  perUnit: PerUnitPurchaseItem[],
  restockItems: RestockItem[]
): ItemizedSelectionState {
  return {
    perUnitQty: {},
    perUnitPrice: Object.fromEntries(perUnit.map((i) => [i.id, i.unitPrice])),
    pooledAmount: {},
    packaging: Object.fromEntries(
      restockItems.map((i) => [
        i.id,
        { packs: 0, priceBaht: i.packPrice, perPack: i.perPack },
      ])
    ),
    extras: [],
  };
}

export type ComputedItemizedSummary = {
  totalSatang: number;
  itemCount: number;
  ingredientCount: number;
  packagingCount: number;
  extraCount: number;
  summaryParts: string[];
  perUnitItems: Array<{ ingredientId: string; quantity: number; unitPriceSatang: number }>;
  pooledItems: Array<{ ingredientId: string; amountSatang: number }>;
  packagingItems: Array<{
    packagingId: string;
    packs: number;
    packPriceSatang: number;
    perPackQuantity: number;
  }>;
  extraExpenses: Array<{
    description: string;
    category: string;
    kind: ExpenseKind;
    amountSatang: number;
  }>;
};

export function computeItemizedSummary(
  state: ItemizedSelectionState,
  perUnit: PerUnitPurchaseItem[],
  pooled: PooledPurchaseItem[],
  restockItems: RestockItem[]
): ComputedItemizedSummary {
  let totalSatang = 0;
  const summaryParts: string[] = [];
  const perUnitItems: ComputedItemizedSummary["perUnitItems"] = [];
  const pooledItems: ComputedItemizedSummary["pooledItems"] = [];
  const packagingItems: ComputedItemizedSummary["packagingItems"] = [];
  const extraExpenses: ComputedItemizedSummary["extraExpenses"] = [];

  for (const item of perUnit) {
    const rawQty = (state.perUnitQty[item.id] ?? "").trim().replace(/,/g, "");
    const qty = rawQty ? Number(rawQty) : 0;
    const rawPrice = state.perUnitPrice[item.id] ?? item.unitPrice ?? "";
    const unitPriceSatang = tryBahtToSatang(rawPrice);
    if (Number.isFinite(qty) && qty > 0 && unitPriceSatang && unitPriceSatang > 0) {
      const lineSatang = Math.round(qty * unitPriceSatang);
      totalSatang += lineSatang;
      perUnitItems.push({
        ingredientId: item.id,
        quantity: qty,
        unitPriceSatang,
      });
      summaryParts.push(`${item.name} ${qty} ${item.purchaseUnit} (${formatBaht(lineSatang)})`);
    }
  }

  for (const item of pooled) {
    const rawAmt = (state.pooledAmount[item.id] ?? "").trim();
    const amountSatang = rawAmt ? tryBahtToSatang(rawAmt) : null;
    if (amountSatang && amountSatang > 0) {
      totalSatang += amountSatang;
      pooledItems.push({
        ingredientId: item.id,
        amountSatang,
      });
      summaryParts.push(`${item.name} (${formatBaht(amountSatang)})`);
    }
  }

  for (const item of restockItems) {
    const row = state.packaging[item.id];
    if (!row || row.packs <= 0) continue;
    const packPriceSatang = tryBahtToSatang(row.priceBaht);
    const perPackQuantity = Number((row.perPack ?? "").replace(/,/g, ""));
    if (packPriceSatang && packPriceSatang > 0 && Number.isFinite(perPackQuantity) && perPackQuantity > 0) {
      const lineSatang = Math.round(row.packs * packPriceSatang);
      totalSatang += lineSatang;
      packagingItems.push({
        packagingId: item.id,
        packs: Math.round(row.packs),
        packPriceSatang,
        perPackQuantity,
      });
      summaryParts.push(`${item.name} ${row.packs} แพ็ก (${formatBaht(lineSatang)})`);
    }
  }

  for (const extra of state.extras) {
    const amountSatang = tryBahtToSatang(extra.amountBaht);
    const desc = extra.description.trim();
    const cat = extra.category.trim();
    if (amountSatang && amountSatang > 0 && desc && cat) {
      totalSatang += amountSatang;
      extraExpenses.push({
        description: desc,
        category: cat,
        kind: extra.kind,
        amountSatang,
      });
      summaryParts.push(`${desc} (${formatBaht(amountSatang)})`);
    }
  }

  const ingredientCount = perUnitItems.length + pooledItems.length;
  const packagingCount = packagingItems.length;
  const extraCount = extraExpenses.length;

  return {
    totalSatang,
    itemCount: ingredientCount + packagingCount + extraCount,
    ingredientCount,
    packagingCount,
    extraCount,
    summaryParts,
    perUnitItems,
    pooledItems,
    packagingItems,
    extraExpenses,
  };
}

export function SlipItemizedPicker({
  perUnit,
  pooled,
  restockItems,
  categories,
  slipAmountSatang = 0,
  value,
  onChange,
  compact = false,
}: {
  perUnit: PerUnitPurchaseItem[];
  pooled: PooledPurchaseItem[];
  restockItems: RestockItem[];
  categories: string[];
  slipAmountSatang?: number;
  value: ItemizedSelectionState;
  onChange: (next: ItemizedSelectionState) => void;
  compact?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<"ingredients" | "packaging" | "extra">("ingredients");
  const summary = computeItemizedSummary(value, perUnit, pooled, restockItems);
  const remainingSatang = slipAmountSatang > 0 ? slipAmountSatang - summary.totalSatang : 0;

  function setPerUnitQty(id: string, nextQty: string) {
    onChange({
      ...value,
      perUnitQty: { ...value.perUnitQty, [id]: nextQty },
    });
  }

  function stepPerUnitQty(id: string, delta: number) {
    const current = Number((value.perUnitQty[id] ?? "0").replace(/,/g, "")) || 0;
    const next = Math.max(0, Math.round((current + delta) * 100) / 100);
    setPerUnitQty(id, next > 0 ? String(next) : "");
  }

  function setPerUnitPrice(id: string, nextPrice: string) {
    onChange({
      ...value,
      perUnitPrice: { ...value.perUnitPrice, [id]: nextPrice },
    });
  }

  function setPooledAmount(id: string, nextBaht: string) {
    onChange({
      ...value,
      pooledAmount: { ...value.pooledAmount, [id]: nextBaht },
    });
  }

  function updatePackaging(id: string, item: RestockItem, patch: Partial<PackagingRowDraft>) {
    const existing = value.packaging[id] ?? {
      packs: 0,
      priceBaht: item.packPrice,
      perPack: item.perPack,
    };
    onChange({
      ...value,
      packaging: {
        ...value.packaging,
        [id]: { ...existing, ...patch },
      },
    });
  }

  function addExtraExpense(prefillSatang?: number) {
    const nextExtra: ExtraExpenseDraft = {
      id: crypto.randomUUID(),
      description: "",
      category: "อื่น ๆ",
      kind: "operating",
      amountBaht: prefillSatang && prefillSatang > 0 ? satangToBahtInput(prefillSatang) : "",
    };
    onChange({
      ...value,
      extras: [...value.extras, nextExtra],
    });
    setActiveTab("extra");
  }

  function updateExtra(id: string, patch: Partial<ExtraExpenseDraft>) {
    onChange({
      ...value,
      extras: value.extras.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    });
  }

  function removeExtra(id: string) {
    onChange({
      ...value,
      extras: value.extras.filter((e) => e.id !== id),
    });
  }

  return (
    <div className={`slip-itemized-picker ${compact ? "is-compact" : ""}`}>
      {/* Category Switcher Tabs inside the Slip */}
      <div className="itemized-subtabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "ingredients"}
          className={`itemized-subtab ${activeTab === "ingredients" ? "active" : ""}`}
          onClick={() => setActiveTab("ingredients")}
        >
          <ShoppingBasket size={15} />
          <span>วัตถุดิบ ({perUnit.length + pooled.length})</span>
          {summary.ingredientCount > 0 && (
            <span className="itemized-badge">{summary.ingredientCount}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "packaging"}
          className={`itemized-subtab ${activeTab === "packaging" ? "active" : ""}`}
          onClick={() => setActiveTab("packaging")}
        >
          <Box size={15} />
          <span>บรรจุภัณฑ์ ({restockItems.length})</span>
          {summary.packagingCount > 0 && (
            <span className="itemized-badge">{summary.packagingCount}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "extra"}
          className={`itemized-subtab ${activeTab === "extra" ? "active" : ""}`}
          onClick={() => setActiveTab("extra")}
        >
          <WalletCards size={15} />
          <span>ค่าใช้จ่ายอื่น</span>
          {summary.extraCount > 0 && <span className="itemized-badge">{summary.extraCount}</span>}
        </button>
      </div>

      {/* TAB 1: INGREDIENTS (Per-unit + Pooled) */}
      {activeTab === "ingredients" && (
        <div className="itemized-pane">
          {perUnit.length > 0 && (
            <>
              <p className="picker-subhead" style={{ marginTop: 0 }}>
                นับต่อชิ้น — กรอกจำนวน{perUnit[0].purchaseUnit} × ราคาต่อ{perUnit[0].purchaseUnit}
              </p>
              <div className="restock-table">
                {perUnit.map((item) => {
                  const rawQty = value.perUnitQty[item.id] ?? "";
                  const qty = Number(rawQty.replace(/,/g, "")) || 0;
                  const rawPrice = value.perUnitPrice[item.id] ?? item.unitPrice ?? "";
                  const priceSatang = tryBahtToSatang(rawPrice);
                  const lineSatang =
                    qty > 0 && priceSatang ? Math.round(qty * priceSatang) : null;

                  return (
                    <div
                      key={item.id}
                      className={`restock-row ${qty > 0 ? "is-active" : ""}`}
                    >
                      <div className="restock-name">
                        <strong>{item.name}</strong>
                        <small>
                          {item.unitsPerPurchaseUnit.toLocaleString("th-TH")} {item.baseUnit}/
                          {item.purchaseUnit}
                          {priceSatang
                            ? ` · ตก${item.baseUnit}ละ ${formatUnitCost(
                                priceSatang / item.unitsPerPurchaseUnit
                              )}`
                            : ""}
                        </small>
                      </div>
                      <div className="restock-inputs is-ingredient">
                        <label className="restock-packs">
                          จำนวน ({item.purchaseUnit})
                          <div className={`stepper ${qty > 0 ? "has-value" : ""}`}>
                            <button
                              type="button"
                              onClick={() => stepPerUnitQty(item.id, -1)}
                              disabled={qty <= 0}
                              aria-label={`ลดจำนวน ${item.name}`}
                            >
                              −
                            </button>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={rawQty}
                              placeholder="0"
                              onChange={(e) => setPerUnitQty(item.id, e.target.value)}
                              aria-label={`จำนวน${item.purchaseUnit} ${item.name}`}
                            />
                            <button
                              type="button"
                              onClick={() => stepPerUnitQty(item.id, 1)}
                              aria-label={`เพิ่มจำนวน ${item.name}`}
                            >
                              +
                            </button>
                          </div>
                        </label>
                        <label>
                          ราคาต่อ{item.purchaseUnit} (บาท)
                          <input
                            type="text"
                            inputMode="decimal"
                            value={rawPrice}
                            placeholder="เช่น 115"
                            onChange={(e) => setPerUnitPrice(item.id, e.target.value)}
                          />
                        </label>
                      </div>
                      <p className="restock-line">
                        {lineSatang !== null ? (
                          <>
                            {qty.toLocaleString("th-TH")} {item.purchaseUnit} ×{" "}
                            {formatBaht(priceSatang!)} = <strong>{formatBaht(lineSatang)}</strong> · ≈{" "}
                            {Math.round(qty * item.unitsPerPurchaseUnit).toLocaleString("th-TH")}{" "}
                            {item.baseUnit}
                          </>
                        ) : qty > 0 ? (
                          `กรอกราคาต่อ${item.purchaseUnit}`
                        ) : (
                          "ไม่ได้ซื้อในสลิปนี้"
                        )}
                      </p>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {pooled.length > 0 && (
            <>
              <div className="itemized-subhead-row">
                <p className="picker-subhead" style={{ margin: 0 }}>
                  คิดเป็น % — กรอกยอดเงินแยกตามรายการที่ซื้อในสลิปนี้ (บาท)
                </p>
                {remainingSatang > 0 && (
                  <span className="remaining-hint-pill">
                    คงเหลือจากสลิป {formatBaht(remainingSatang)} (กดปุ่ม &quot;+ เติมยอดที่เหลือ&quot; ในช่องได้)
                  </span>
                )}
              </div>
              <div className="amount-grid itemized-pooled-grid">
                {pooled.map((item) => {
                  const raw = value.pooledAmount[item.id] ?? "";
                  const parsed = raw.trim() ? tryBahtToSatang(raw) : null;
                  const invalid = raw.trim() !== "" && parsed === null;
                  const isActive = Boolean(parsed && parsed > 0);
                  const currentSatang = parsed ?? 0;

                  return (
                    <div
                      key={item.id}
                      className={`pooled-item-box ${isActive ? "is-active" : ""}`}
                    >
                      <div className="pooled-item-head">
                        <label htmlFor={`pooled-${item.id}`}>{item.name} (บาท)</label>
                        {remainingSatang > 0 && (
                          <button
                            type="button"
                            className="fill-remaining-mini-btn"
                            title={`เติมยอดคงเหลือ ${formatBaht(remainingSatang)} ลงใน ${item.name}`}
                            onClick={() =>
                              setPooledAmount(
                                item.id,
                                satangToBahtInput(currentSatang + remainingSatang)
                              )
                            }
                          >
                            +{formatBaht(remainingSatang)}
                          </button>
                        )}
                      </div>
                      <input
                        id={`pooled-${item.id}`}
                        type="text"
                        inputMode="decimal"
                        value={raw}
                        placeholder="0"
                        aria-invalid={invalid}
                        onChange={(e) => setPooledAmount(item.id, e.target.value)}
                      />
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {perUnit.length === 0 && pooled.length === 0 && (
            <p className="muted-note">ยังไม่มีรายการวัตถุดิบในระบบ</p>
          )}
        </div>
      )}

      {/* TAB 2: PACKAGING */}
      {activeTab === "packaging" && (
        <div className="itemized-pane">
          {restockItems.length > 0 ? (
            <div className="restock-table">
              {restockItems.map((item) => {
                const row = value.packaging[item.id] ?? {
                  packs: 0,
                  priceBaht: item.packPrice,
                  perPack: item.perPack,
                };
                const priceSatang = tryBahtToSatang(row.priceBaht);
                const perPackNum = Number((row.perPack ?? "").replace(/,/g, ""));
                const active = row.packs > 0;
                const valid =
                  priceSatang !== null &&
                  priceSatang > 0 &&
                  Number.isFinite(perPackNum) &&
                  perPackNum > 0;

                return (
                  <div
                    key={item.id}
                    className={`restock-row ${active ? "is-active" : ""}`}
                  >
                    <div className="restock-name">
                      <strong>{item.name}</strong>
                      <small>
                        {item.perOrder ? "ต่อออเดอร์" : "ลงค่าใช้จ่าย"}
                        {valid
                          ? ` · ตก${item.unit}ละ ${formatUnitCost(priceSatang! / perPackNum)}`
                          : ""}
                      </small>
                    </div>
                    <div className="restock-inputs">
                      <label className="restock-packs">
                        จำนวนแพ็ก
                        <div className={`stepper ${active ? "has-value" : ""}`}>
                          <button
                            type="button"
                            onClick={() =>
                              updatePackaging(item.id, item, {
                                packs: Math.max(0, row.packs - 1),
                              })
                            }
                            disabled={row.packs <= 0}
                            aria-label={`ลดจำนวนแพ็ก ${item.name}`}
                          >
                            −
                          </button>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={row.packs > 0 ? String(row.packs) : "0"}
                            onChange={(e) => {
                              const n = Math.max(0, parseInt(e.target.value || "0", 10) || 0);
                              updatePackaging(item.id, item, { packs: n });
                            }}
                            aria-label={`จำนวนแพ็ก ${item.name}`}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              updatePackaging(item.id, item, { packs: row.packs + 1 })
                            }
                            aria-label={`เพิ่มจำนวนแพ็ก ${item.name}`}
                          >
                            +
                          </button>
                        </div>
                      </label>
                      <label>
                        ราคา/แพ็ก (บาท)
                        <input
                          type="text"
                          inputMode="decimal"
                          value={row.priceBaht}
                          placeholder="เช่น 65"
                          onChange={(e) =>
                            updatePackaging(item.id, item, { priceBaht: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        {item.unit}/แพ็ก
                        <input
                          type="text"
                          inputMode="decimal"
                          value={row.perPack}
                          placeholder="เช่น 25"
                          onChange={(e) =>
                            updatePackaging(item.id, item, { perPack: e.target.value })
                          }
                        />
                      </label>
                    </div>
                    <p className="restock-line">
                      {active && valid ? (
                        <>
                          {row.packs.toLocaleString("th-TH")} แพ็ก ={" "}
                          <strong>{formatBaht(priceSatang! * row.packs)}</strong> ·{" "}
                          {(perPackNum * row.packs).toLocaleString("th-TH")} {item.unit}
                        </>
                      ) : active ? (
                        "กรอกราคาและจำนวนต่อแพ็ก"
                      ) : (
                        "ไม่ได้ซื้อในสลิปนี้"
                      )}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted-note">ยังไม่มีรายการบรรจุภัณฑ์ในระบบ</p>
          )}
        </div>
      )}

      {/* TAB 3: EXTRA / OTHER EXPENSES IN SAME SLIP */}
      {activeTab === "extra" && (
        <div className="itemized-pane">
          <p className="picker-subhead" style={{ marginTop: 0 }}>
            รายการค่าใช้จ่ายทั่วไปที่รวมอยู่ในสลิปเดียวกัน (เช่น น้ำแข็ง, ค่าแก๊ส, ค่าน้ำมัน, อื่นๆ)
          </p>
          {value.extras.length > 0 && (
            <div className="extra-expense-list">
              {value.extras.map((extra) => (
                <div key={extra.id} className="extra-expense-row">
                  <label>
                    รายละเอียด
                    <input
                      type="text"
                      value={extra.description}
                      placeholder="เช่น น้ำแข็ง / ค่าถุง / อื่นๆ"
                      onChange={(e) =>
                        updateExtra(extra.id, { description: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    หมวดหมู่
                    <input
                      type="text"
                      list="expense-categories"
                      value={extra.category}
                      placeholder={`เช่น ${FUEL_CATEGORY}`}
                      onChange={(e) => {
                        const nextCat = e.target.value;
                        updateExtra(extra.id, {
                          category: nextCat,
                          ...(!extra.description.trim() && categories.includes(nextCat)
                            ? { description: nextCat }
                            : {}),
                        });
                      }}
                    />
                  </label>
                  <label>
                    จำนวนเงิน (บาท)
                    <input
                      type="text"
                      inputMode="decimal"
                      value={extra.amountBaht}
                      placeholder="0.00"
                      onChange={(e) =>
                        updateExtra(extra.id, { amountBaht: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    ประเภท
                    <select
                      value={extra.kind}
                      onChange={(e) =>
                        updateExtra(extra.id, { kind: e.target.value as ExpenseKind })
                      }
                    >
                      {(Object.keys(EXPENSE_KIND_LABELS) as ExpenseKind[]).map((k) => (
                        <option key={k} value={k}>
                          {EXPENSE_KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() => removeExtra(extra.id)}
                    aria-label="ลบรายการนี้"
                    style={{ alignSelf: "end", marginBottom: "3px" }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" }}>
            <button
              type="button"
              className="secondary-button"
              onClick={() => addExtraExpense()}
              style={{ minHeight: "38px", fontSize: "12.5px" }}
            >
              <Plus size={15} /> เพิ่มรายการค่าใช้จ่ายอื่นในสลิปนี้
            </button>
            {remainingSatang > 0 && (
              <button
                type="button"
                className="chip-btn round-up"
                onClick={() => addExtraExpense(remainingSatang)}
                style={{ minHeight: "38px", fontSize: "12.5px", padding: "0 14px" }}
              >
                <Sparkles size={14} style={{ marginRight: "5px", verticalAlign: "middle" }} />
                ใส่ยอดที่เหลือจากสลิป ({formatBaht(remainingSatang)}) เป็นรายการอื่น
              </button>
            )}
          </div>
        </div>
      )}

      {/* REAL-TIME SUMMARY & SLIP TOTAL COMPARISON BAR */}
      <div
        className={`itemized-summary-bar ${
          summary.itemCount > 0
            ? slipAmountSatang > 0 && summary.totalSatang !== slipAmountSatang
              ? "is-diff"
              : "is-ready"
            : ""
        }`}
        aria-live="polite"
      >
        <div className="itemized-summary-main">
          {summary.itemCount > 0 ? (
            <>
              <div className="itemized-summary-title">
                <CheckCircle2 size={16} />
                <span>
                  เลือก <strong>{summary.itemCount} รายการ</strong> · รวมทั้งสิ้น{" "}
                  <strong className="itemized-total-num">{formatBaht(summary.totalSatang)}</strong>
                </span>
              </div>
              <div className="itemized-chips-preview">
                {summary.summaryParts.map((part, idx) => (
                  <span key={idx} className="itemized-summary-chip">
                    {part}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <span>
              กรอกเฉพาะรายการที่ซื้อในสลิปนี้ (เช่น พริก กระเทียม ไก่ หรือกล่อง) ที่เหลือปล่อยว่างได้
            </span>
          )}
        </div>

        {slipAmountSatang > 0 && summary.itemCount > 0 && (
          <div className="itemized-slip-compare">
            {summary.totalSatang === slipAmountSatang ? (
              <span className="compare-badge match">
                ✓ ตรงกับยอดในสลิป ({formatBaht(slipAmountSatang)}) พอดี
              </span>
            ) : summary.totalSatang < slipAmountSatang ? (
              <span className="compare-badge diff">
                ยังขาดอีก {formatBaht(slipAmountSatang - summary.totalSatang)} จากยอดสลิป (
                {formatBaht(slipAmountSatang)})
              </span>
            ) : (
              <span className="compare-badge diff">
                เกินยอดสลิป ({formatBaht(slipAmountSatang)}) อยู่{" "}
                {formatBaht(summary.totalSatang - slipAmountSatang)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
