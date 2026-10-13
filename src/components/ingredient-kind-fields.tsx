"use client";

import { useState } from "react";

/**
 * Fields of the "new ingredient" form. Per-piece items (chicken) need units and pieces per unit;
 * pooled items (rice, herbs, sauce) only need a name.
 */
export function IngredientKindFields() {
  const [costing, setCosting] = useState<"per_unit" | "pooled">("per_unit");
  return <>
    <label>วิธีคิดต้นทุน
      <select name="costing" value={costing} onChange={(e) => setCosting(e.target.value as "per_unit" | "pooled")}>
        <option value="per_unit">นับต่อชิ้น — วัตถุดิบหลัก เช่น ไก่</option>
        <option value="pooled">คิดเป็น % — ข้าว พริก กระเทียม ผักชี มะนาว ซอส</option>
      </select>
    </label>
    {costing === "per_unit" ? <>
      <label>ซื้อเป็นหน่วย<input name="purchase_unit" maxLength={30} required defaultValue="กก." /></label>
      <label>ใช้ในสูตรเป็นหน่วย<input name="base_unit" maxLength={30} required defaultValue="ชิ้น" /></label>
      <label>1 หน่วยที่ซื้อ ได้ประมาณกี่หน่วยในสูตร<input name="units_per_purchase_unit" inputMode="decimal" required defaultValue="27" /></label>
      <label className="check-label"><input type="checkbox" name="yield_auto" value="true" defaultChecked /> ปรับจำนวนชิ้น/กก. อัตโนมัติจากยอดขายจริง</label>
      <p className="field-hint wide">เช่น ไก่ 1 กก. ≈ 27 ชิ้น · เมนู 69 ใส่ 5 ชิ้น เมนู 89 ใส่ 7 ชิ้น — ตั้งในหน้าเมนู · ถ้าเปิดอัตโนมัติ ระบบจะเทียบชิ้นที่ขายได้กับกิโลที่ซื้อ (ต้องมีการซื้อ 3 ครั้งขึ้นไป ในช่วง 7 วัน+)</p>
    </> : <p className="field-hint wide">ไม่ต้องใส่หน่วย — ตอนซื้อกรอกแค่ราคาที่จ่าย ระบบรวมยอดซื้อทั้งหมด ÷ ยอดขายอาหาร 30 วัน เป็น % แล้วบวกเข้าต้นทุนทุกออเดอร์</p>}
  </>;
}
