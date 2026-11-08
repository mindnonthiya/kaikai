"use client";

import { useState } from "react";

type UnitPreset = {
  label: string;
  hint: string;
  purchaseUnit: string;
  baseUnit: string;
  unitsPerPurchase: string;
  yieldAuto: boolean;
};

const UNIT_PRESETS: UnitPreset[] = [
  {
    label: "⚖️ ชั่งเป็นกรัม (ซื้อเป็น กก.)",
    hint: "เช่น แป้ง น้ำตาล เนย เนื้อสัตว์ ผงชง (1 กก. = 1,000 กรัม)",
    purchaseUnit: "กก.",
    baseUnit: "กรัม",
    unitsPerPurchase: "1000",
    yieldAuto: false,
  },
  {
    label: "🫙 ชั่งเป็นกรัม (ซื้อเป็นกระปุก/ถุง)",
    hint: "เช่น ซอส แยม ช็อกโกแลต พริกเผา ท็อปปิ้ง (ปรับน้ำหนักกรัมตามขนาดจริงได้)",
    purchaseUnit: "กระปุก",
    baseUnit: "กรัม",
    unitsPerPurchase: "900",
    yieldAuto: false,
  },
  {
    label: "🥛 ตวงเป็น มล. (ซื้อเป็นลิตร/ขวด)",
    hint: "เช่น นมสด น้ำมันพืช ไซรัป น้ำเชื่อม (1 ลิตร = 1,000 มล.)",
    purchaseUnit: "ลิตร",
    baseUnit: "มล.",
    unitsPerPurchase: "1000",
    yieldAuto: false,
  },
  {
    label: "🥚 นับเป็นฟอง/แผ่น (ซื้อเป็นแผง/แพ็ก)",
    hint: "เช่น ไข่ (1 แผง = 30 ฟอง), ชีสแผ่น, แฮม, ไส้กรอก",
    purchaseUnit: "แผง",
    baseUnit: "ฟอง",
    unitsPerPurchase: "30",
    yieldAuto: false,
  },
  {
    label: "🍖 นับเป็นชิ้น (หั่นจาก กก.)",
    hint: "เช่น เนื้อสัตว์หั่นชิ้น ลูกชิ้น ของสดนับชิ้น (ปรับจำนวนชิ้น/กก. จากยอดขายจริงได้)",
    purchaseUnit: "กก.",
    baseUnit: "ชิ้น",
    unitsPerPurchase: "27",
    yieldAuto: true,
  },
];

/**
 * Fields of the "new ingredient" form.
 * Supports any unit (กรัม, มล., ฟอง, แผ่น, ชิ้น) with 1-click presets for any restaurant/shop,
 * as well as pooled (%) items.
 */
export function IngredientKindFields() {
  const [costing, setCosting] = useState<"per_unit" | "pooled">("per_unit");
  const [purchaseUnit, setPurchaseUnit] = useState("กก.");
  const [baseUnit, setBaseUnit] = useState("กรัม");
  const [unitsPerPurchase, setUnitsPerPurchase] = useState("1000");
  const [yieldAuto, setYieldAuto] = useState(false);
  const [activeHint, setActiveHint] = useState(UNIT_PRESETS[0].hint);

  const applyPreset = (p: UnitPreset) => {
    setPurchaseUnit(p.purchaseUnit);
    setBaseUnit(p.baseUnit);
    setUnitsPerPurchase(p.unitsPerPurchase);
    setYieldAuto(p.yieldAuto);
    setActiveHint(p.hint);
  };

  return <>
    <label>วิธีคิดต้นทุน
      <select name="costing" value={costing} onChange={(e) => setCosting(e.target.value as "per_unit" | "pooled")}>
        <option value="per_unit">ระบุปริมาณในสูตร — คิดตามกรัม / มล. / ชิ้น / ฟอง / แผ่น</option>
        <option value="pooled">คิดเป็น % ของยอดขาย — ของใช้รวมที่ไม่ชั่งตวงรายจาน (เช่น เครื่องปรุงรวม แก๊ส น้ำแข็ง)</option>
      </select>
    </label>
    {costing === "per_unit" ? <>
      <div className="wide" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "var(--muted)" }}>เลือกหน่วยสำเร็จรูป (กดปุ่มเพื่อตั้งค่าไว หรือพิมพ์แก้ด้านล่างได้เลย):</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {UNIT_PRESETS.map((p) => {
            const isSelected = purchaseUnit === p.purchaseUnit && baseUnit === p.baseUnit && unitsPerPurchase === p.unitsPerPurchase;
            return (
              <button
                key={p.label}
                type="button"
                className={`pill ${isSelected ? "active" : ""}`}
                style={{ fontSize: "0.8rem", padding: "5px 10px", cursor: "pointer" }}
                onClick={() => applyPreset(p)}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {activeHint && <small className="muted" style={{ fontSize: "0.78rem" }}>{activeHint}</small>}
      </div>
      <label>ซื้อเป็นหน่วย (เช่น กก., กระปุก, แผง, ลิตร)
        <input name="purchase_unit" maxLength={30} required value={purchaseUnit} onChange={(e) => setPurchaseUnit(e.target.value)} />
      </label>
      <label>ใช้ในสูตรเป็นหน่วย (เช่น กรัม, มล., ฟอง, ชิ้น)
        <input name="base_unit" maxLength={30} required value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} />
      </label>
      <label>1 {purchaseUnit || "หน่วยที่ซื้อ"} ได้กี่ {baseUnit || "หน่วยในสูตร"}
        <input name="units_per_purchase_unit" inputMode="decimal" required value={unitsPerPurchase} onChange={(e) => setUnitsPerPurchase(e.target.value)} />
      </label>
      <label className="check-label">
        <input type="checkbox" name="yield_auto" value="true" checked={yieldAuto} onChange={(e) => setYieldAuto(e.target.checked)} />
        ปรับจำนวน {baseUnit || "หน่วย"}/{purchaseUnit || "หน่วยซื้อ"} อัตโนมัติจากยอดขายจริง (เหมาะกับของสดที่หั่นแบ่งชิ้น)
      </label>
      <p className="field-hint wide">
        ตอนตั้งสูตรในหน้าเมนู คุณจะกรอกแค่ว่าใช้กี่ <strong>{baseUnit || "หน่วย"}</strong> (ไม่ต้องกรอกราคาซ้ำ) ระบบจะดึงราคาซื้อมาคำนวณต้นทุนต่อหน่วยและคิดสัดส่วน % ในสูตรให้อัตโนมัติ
      </p>
    </> : <p className="field-hint wide">ไม่ต้องใส่หน่วย — ตอนซื้อกรอกแค่ราคาที่จ่าย ระบบรวมยอดซื้อทั้งหมด ÷ ยอดขายอาหาร 30 วัน เป็น % แล้วบวกเข้าต้นทุนทุกออเดอร์</p>}
  </>;
}
