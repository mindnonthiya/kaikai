"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { StepperInput } from "@/components/stepper-input";
import { saveMenuRecipe } from "@/app/actions/menus";
import { formatPercentBps, pooledCost, recipeCostParts, recipeIngredientBreakdown } from "@/lib/analytics";
import type { IngredientRecord, MenuRecord, RecipeItemRecord } from "@/lib/data/types";
import { isAddonCategory } from "@/lib/data/types";
import { formatBaht, formatUnitCost } from "@/lib/money";

export type EditorIngredientRow = {
  id: string;
  key: string;
  name: string;
  unit: string;
  unitCost: number;
  quantity: number;
  costing: "per_unit" | "pooled";
  note?: string;
};

export type EditorPackRow = {
  id: string;
  key: string;
  name: string;
  unit: string;
  unitCost: number;
  quantity: number;
  note?: string;
};

export function RecipeEditorForm({
  menu,
  ingredientRows,
  packRows,
  ingredients,
  pooledBps,
  unitLabel,
}: {
  menu: MenuRecord;
  ingredientRows: EditorIngredientRow[];
  packRows: EditorPackRow[];
  ingredients: IngredientRecord[];
  pooledBps: number;
  unitLabel: string;
}) {
  const [ingQty, setIngQty] = useState<Record<string, number>>(() =>
    Object.fromEntries(ingredientRows.map((r) => [r.id, r.quantity])),
  );
  const [packQty, setPackQty] = useState<Record<string, number>>(() =>
    Object.fromEntries(packRows.map((r) => [r.id, r.quantity])),
  );

  const isAddon = isAddonCategory(menu.category);
  const serveUnit = isAddon ? "ชิ้น" : unitLabel;
  const effectiveYield = Number.isFinite(menu.recipeYield) && (menu.recipeYield ?? 0) > 0 ? Number(menu.recipeYield) : 1;

  // Build synthetic RecipeItemRecord[] from live state to compute live breakdown & costs
  const liveRecipeItems: RecipeItemRecord[] = [
    ...ingredientRows
      .filter((r) => (ingQty[r.id] ?? 0) > 0)
      .map((r) => ({ id: r.key, menuId: menu.id, ingredientId: r.id, packagingItemId: null, quantity: ingQty[r.id] ?? 0 })),
    ...packRows
      .filter((r) => (packQty[r.id] ?? 0) > 0)
      .map((r) => ({ id: r.key, menuId: menu.id, ingredientId: null, packagingItemId: r.id, quantity: packQty[r.id] ?? 0 })),
  ];

  const breakdown = recipeIngredientBreakdown(liveRecipeItems, ingredients, effectiveYield);
  const breakdownById = new Map(breakdown.rows.map((b) => [b.ingredientId, b]));

  const ingCostMap = new Map(ingredientRows.map((r) => [r.id, r.unitCost]));
  const packCostMap = new Map(packRows.map((r) => [r.id, r.unitCost]));
  const perServingParts = recipeCostParts(liveRecipeItems, ingCostMap, packCostMap, effectiveYield);
  const pool = pooledCost(menu.price, pooledBps);
  const totalPerServing = Math.round(perServingParts.ingredients + perServingParts.packaging) + pool;
  const estProfit = menu.price - totalPerServing;
  const estMarginBps = menu.price > 0 ? Math.round((estProfit * 10_000) / menu.price) : 0;

  return (
    <ActionForm action={saveMenuRecipe} submitLabel="บันทึกสูตร" className="form-grid compact" resetOnSuccess={false}>
      <input type="hidden" name="menu_id" value={menu.id} />

      <div className="recipe-rows">
        {ingredientRows.length > 0 && (
          <p className="recipe-group">
            วัตถุดิบ (กรอกเฉพาะปริมาณที่ใช้ · ระบบคำนวณ ฿ และ % ให้อัตโนมัติ)
          </p>
        )}
        {ingredientRows.map((row) => {
          const currentQty = ingQty[row.id] ?? 0;
          const info = breakdownById.get(row.id);
          const isWeightOrVol = row.unit === "กรัม" || row.unit === "มล." || row.unit === "g" || row.unit === "ml";
          return (
            <div key={row.key} className="recipe-row" style={{ alignItems: "center" }}>
              <span>
                <strong>{row.name}</strong>
                <small>
                  {row.note ?? (row.unitCost ? `${formatUnitCost(row.unitCost)}/${row.unit}` : "ยังไม่มีราคาซื้อ")}
                </small>
                {currentQty > 0 && info ? (
                  <small style={{ display: "block", color: "var(--accent, #0f766e)", fontWeight: 500, marginTop: 2 }}>
                    ต้นทุน {formatBaht(info.perServingCost)} · สัดส่วนในสูตร {formatPercentBps(info.quantityShareBps)}
                    {info.costShareBps > 0 ? ` · สัดส่วนทุน ${formatPercentBps(info.costShareBps)}` : ""}
                  </small>
                ) : null}
              </span>
              <StepperInput
                name={row.key}
                defaultValue={row.quantity}
                step={isWeightOrVol ? 10 : 1}
                label={`${row.name} (${row.unit})`}
                onChange={(val) => setIngQty((prev) => ({ ...prev, [row.id]: val }))}
              />
              <small className="recipe-unit">{row.unit}</small>
            </div>
          );
        })}

        {packRows.length > 0 && (
          <p className="recipe-group">บรรจุภัณฑ์</p>
        )}
        {packRows.map((row) => {
          const currentQty = packQty[row.id] ?? 0;
          const lineCost = Math.round(currentQty * row.unitCost);
          return (
            <div key={row.key} className="recipe-row" style={{ alignItems: "center" }}>
              <span>
                <strong>{row.name}</strong>
                <small>
                  {row.note ?? (row.unitCost ? `${formatUnitCost(row.unitCost)}/${row.unit}` : "ยังไม่มีราคาซื้อ")}
                  {currentQty > 0 && lineCost > 0 ? ` · ต้นทุน ${formatBaht(lineCost)}` : ""}
                </small>
              </span>
              <StepperInput
                name={row.key}
                defaultValue={row.quantity}
                step={1}
                label={`${row.name} (${row.unit})`}
                onChange={(val) => setPackQty((prev) => ({ ...prev, [row.id]: val }))}
              />
              <small className="recipe-unit">{row.unit}</small>
            </div>
          );
        })}
      </div>

      {/* Live Cost & Profit Breakdown Summary */}
      <div
        className="wide"
        style={{
          background: "var(--surface-subtle, rgba(0,0,0,0.03))",
          borderRadius: 10,
          padding: "10px 12px",
          fontSize: "0.83rem",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="muted">ต้นทุนวัตถุดิบตามสูตร:</span>
          <strong>{formatBaht(perServingParts.ingredients)}</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="muted">ต้นทุนบรรจุภัณฑ์:</span>
          <strong>{formatBaht(perServingParts.packaging)}</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="muted">วัตถุดิบอื่น ({formatPercentBps(pooledBps)} ของราคาขาย):</span>
          <strong>{formatBaht(pool)}</strong>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: "1px solid var(--border, rgba(0,0,0,0.08))",
            paddingTop: 6,
            marginTop: 2,
          }}
        >
          <span><strong>รวมต้นทุนต่อ 1 {serveUnit}:</strong></span>
          <strong>{formatBaht(totalPerServing)} (กำไร {formatBaht(estProfit)} · {formatPercentBps(estMarginBps)})</strong>
        </div>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.875rem", margin: "6px 0", cursor: "pointer" }}>
        <input type="checkbox" name="sync_past_sales" value="true" />
        <span>คำนวณต้นทุนย้อนหลังให้ออเดอร์เก่าที่เคยขายไปแล้วด้วย</span>
      </label>
      <p className="field-hint wide">
        {isAddon
          ? "ท็อปปิ้ง/ไส้เพิ่ม/ของเพิ่ม: กรอกแค่จำนวนกรัมหรือชิ้นที่ใช้ ระบบคำนวณต้นทุนและกำไรให้อัตโนมัติ"
          : `กรอกเฉพาะปริมาณวัตถุดิบที่ใช้ต่อ 1 ${serveUnit} (เช่น กรัม มล. ชิ้น แผ่น) ระบบดึงราคาซื้อมาคำนวณต้นทุนและ % สัดส่วนในสูตรให้อัตโนมัติ`}
      </p>
    </ActionForm>
  );
}
