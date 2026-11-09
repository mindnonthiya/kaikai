"use client";

import { useState } from "react";
import { formatUnitCost, tryBahtToSatang } from "@/lib/money";

type UnitPreset = {
  icon: string;
  title: string;
  subtitle: string;
  hint: string;
  purchaseUnit: string;
  baseUnit: string;
  unitsPerPurchase: string;
  yieldAuto: boolean;
};

const UNIT_PRESETS: UnitPreset[] = [
  {
    icon: "⚖️",
    title: "ชั่งเป็นกรัม (ซื้อเป็น กก.)",
    subtitle: "1 กก. = 1,000 กรัม",
    hint: "เหมาะกับ แป้ง น้ำตาล เนย เนื้อสัตว์ ผงชง เครื่องปรุงแบบชั่งน้ำหนัก",
    purchaseUnit: "กก.",
    baseUnit: "กรัม",
    unitsPerPurchase: "1000",
    yieldAuto: false,
  },
  {
    icon: "🫙",
    title: "ชั่งเป็นกรัม (กระปุก/ถุง)",
    subtitle: "1 กระปุก = 900 กรัม (แก้ได้)",
    hint: "เหมาะกับ ซอส แยม ช็อกโกแลต พริกเผา ท็อปปิ้ง (ปรับน้ำหนักกรัมตามขนาดจริงได้)",
    purchaseUnit: "กระปุก",
    baseUnit: "กรัม",
    unitsPerPurchase: "900",
    yieldAuto: false,
  },
  {
    icon: "🥛",
    title: "ตวงเป็น มล. (ซื้อเป็นลิตร/ขวด)",
    subtitle: "1 ลิตร = 1,000 มล.",
    hint: "เหมาะกับ นมสด น้ำมันพืช ไซรัป น้ำเชื่อม กะทิ หรือของเหลวทุกชนิด",
    purchaseUnit: "ลิตร",
    baseUnit: "มล.",
    unitsPerPurchase: "1000",
    yieldAuto: false,
  },
  {
    icon: "🥚",
    title: "นับเป็นฟอง/แผ่น (แผง/แพ็ก)",
    subtitle: "1 แผง = 30 ฟอง (แก้ได้)",
    hint: "เหมาะกับ ไข่ไก่ (1 แผง = 30 ฟอง), ชีสแผ่น, แฮม, ไส้กรอก, ขนมปังแผ่น",
    purchaseUnit: "แผง",
    baseUnit: "ฟอง",
    unitsPerPurchase: "30",
    yieldAuto: false,
  },
  {
    icon: "🍖",
    title: "นับเป็นชิ้น (หั่นจาก กก.)",
    subtitle: "1 กก. ≈ 27 ชิ้น (เฉลี่ยได้)",
    hint: "เหมาะกับ เนื้อสัตว์หั่นชิ้น ลูกชิ้น ของสดนับชิ้น (ปรับจำนวนชิ้น/กก. จากยอดขายจริงได้)",
    purchaseUnit: "กก.",
    baseUnit: "ชิ้น",
    unitsPerPurchase: "27",
    yieldAuto: true,
  },
];

/**
 * Fields of the "new ingredient" form.
 * Supports any unit (กรัม, มล., ฟอง, แผ่น, ชิ้น) with 1-click presets for any restaurant/shop,
 * plus an optional initial price per purchase unit so the owner can compute recipe costs immediately
 * without recording a fake purchase/expense.
 */
export function IngredientKindFields() {
  const [costing, setCosting] = useState<"per_unit" | "pooled">("per_unit");
  const [purchaseUnit, setPurchaseUnit] = useState("กก.");
  const [baseUnit, setBaseUnit] = useState("กรัม");
  const [unitsPerPurchase, setUnitsPerPurchase] = useState("1000");
  const [initialPrice, setInitialPrice] = useState("");
  const [yieldAuto, setYieldAuto] = useState(false);
  const [activeHint, setActiveHint] = useState(UNIT_PRESETS[0].hint);

  const applyPreset = (p: UnitPreset) => {
    setPurchaseUnit(p.purchaseUnit);
    setBaseUnit(p.baseUnit);
    setUnitsPerPurchase(p.unitsPerPurchase);
    setYieldAuto(p.yieldAuto);
    setActiveHint(p.hint);
  };

  const priceSatang = initialPrice.trim() ? tryBahtToSatang(initialPrice) : null;
  const unitsNum = Number(unitsPerPurchase.replace(/,/g, ""));
  const validPreview = priceSatang !== null && priceSatang > 0 && Number.isFinite(unitsNum) && unitsNum > 0;

  return <>
    <label>วิธีคิดต้นทุน
      <select name="costing" value={costing} onChange={(e) => setCosting(e.target.value as "per_unit" | "pooled")}>
        <option value="per_unit">ระบุปริมาณในสูตร — คิดตามกรัม / มล. / ชิ้น / ฟอง / แผ่น</option>
        <option value="pooled">คิดเป็น % ของยอดขาย — ของใช้รวมที่ไม่ชั่งตวงรายจาน (เช่น เครื่องปรุงรวม แก๊ส น้ำแข็ง)</option>
      </select>
    </label>
    {costing === "per_unit" ? <>
      <div className="unit-preset-section">
        <div className="unit-preset-head">
          <strong>เลือกหน่วยสำเร็จรูป</strong>
          <span>กดเลือกเพื่อตั้งค่าไว หรือพิมพ์แก้ไขช่องด้านล่างเองได้เลย</span>
        </div>
        <div className="unit-preset-grid" role="group" aria-label="ตัวเลือกหน่วยสำเร็จรูป">
          {UNIT_PRESETS.map((p) => {
            const isSelected =
              purchaseUnit === p.purchaseUnit &&
              baseUnit === p.baseUnit &&
              unitsPerPurchase === p.unitsPerPurchase;
            return (
              <button
                key={p.title}
                type="button"
                className={`unit-preset-card ${isSelected ? "active" : ""}`}
                onClick={() => applyPreset(p)}
                aria-pressed={isSelected}
              >
                <span className="unit-preset-icon" aria-hidden="true">{p.icon}</span>
                <span className="unit-preset-info">
                  <strong>{p.title}</strong>
                  <small>{p.subtitle}</small>
                </span>
              </button>
            );
          })}
        </div>
        {activeHint && (
          <p className="unit-preset-hint">
            <span>💡</span>
            <span>{activeHint}</span>
          </p>
        )}
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
      <label>ราคาต่อ 1 {purchaseUnit || "หน่วยที่ซื้อ"} ตั้งต้น (บาท — ไม่บังคับ)
        <input
          name="initial_price"
          inputMode="decimal"
          placeholder="เช่น 120 (เว้นว่างได้)"
          value={initialPrice}
          onChange={(e) => setInitialPrice(e.target.value)}
          aria-invalid={initialPrice.trim() !== "" && priceSatang === null}
        />
      </label>
      {validPreview && (
        <p className="pack-preview is-ready wide" aria-live="polite" style={{ margin: "2px 0" }}>
          ตก{baseUnit || "หน่วย"}ละ <strong>{formatUnitCost(priceSatang! / unitsNum)}</strong> · ใช้คำนวณต้นทุนในสูตรเมนูได้ทันทีโดยไม่ตัดเป็นบิลค่าใช้จ่ายวันนี้
        </p>
      )}
      <label className="check-label wide">
        <input type="checkbox" name="yield_auto" value="true" checked={yieldAuto} onChange={(e) => setYieldAuto(e.target.checked)} />
        ปรับจำนวน {baseUnit || "หน่วย"}/{purchaseUnit || "หน่วยซื้อ"} อัตโนมัติจากยอดขายจริง (เหมาะกับของสดที่หั่นแบ่งชิ้น)
      </label>
      <p className="field-hint wide">
        การเพิ่มวัตถุดิบเป็นการตั้งค่าข้อมูลตั้งต้นของร้าน (ยังไม่ถูกหักเป็นค่าใช้จ่าย) · ตอนตั้งสูตรในหน้าเมนู คุณจะกรอกแค่ว่าใช้กี่ <strong>{baseUnit || "หน่วย"}</strong> ระบบจะคำนวณต้นทุนและสัดส่วน % ในสูตรให้อัตโนมัติ
      </p>
    </> : <p className="field-hint wide">ไม่ต้องใส่หน่วย — ตอนซื้อของจริงค่อยกรอกราคาที่จ่าย ระบบรวมยอดซื้อทั้งหมด ÷ ยอดขายอาหาร 30 วัน เป็น % แล้วบวกเข้าต้นทุนทุกออเดอร์</p>}
  </>;
}
