"use client";

import { useState } from "react";
import { Bike, Check, Edit2, Plus, Store, Trash2, X } from "lucide-react";
import { saveAllPricePresets } from "@/app/actions/presets";
import type { Fulfillment, MenuRecord, PricePreset, PricePresetItem } from "@/lib/data/types";
import { formatBaht, satangToBahtInput, tryBahtToSatang } from "@/lib/money";

type Props = {
  initialPresets: PricePreset[];
  menus: MenuRecord[];
  defaultDeliveryFee: number;
  deliveryFeeOptions?: number[];
};

export function PresetManager({ initialPresets, menus, defaultDeliveryFee, deliveryFeeOptions }: Props) {
  const feeOptions = Array.from(new Set([defaultDeliveryFee, ...(deliveryFeeOptions ?? [1500, 2000])])).sort((a, b) => a - b);
  const [presets, setPresets] = useState<PricePreset[]>(initialPresets);
  const [editingPreset, setEditingPreset] = useState<PricePreset | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Form states
  const [name, setName] = useState("");
  const [amountBaht, setAmountBaht] = useState("");
  const [fulfillment, setFulfillment] = useState<Fulfillment>("delivery");
  const [deliveryFeeBaht, setDeliveryFeeBaht] = useState(satangToBahtInput(defaultDeliveryFee));
  const [items, setItems] = useState<PricePresetItem[]>([]);
  const [notes, setNotes] = useState("");

  const menuMap = new Map(menus.map((m) => [m.id, m]));

  function openCreate() {
    setIsCreating(true);
    setEditingPreset(null);
    setName("");
    setAmountBaht("");
    setFulfillment("delivery");
    setDeliveryFeeBaht(satangToBahtInput(defaultDeliveryFee));
    setItems(menus.length > 0 ? [{ menuId: menus[0].id, quantity: 1 }] : []);
    setNotes("");
    setStatusMessage(null);
  }

  function openEdit(preset: PricePreset) {
    setIsCreating(false);
    setEditingPreset(preset);
    setName(preset.name);
    setAmountBaht(satangToBahtInput(preset.amountSatang));
    setFulfillment(preset.fulfillment);
    setDeliveryFeeBaht(satangToBahtInput(preset.deliveryChargedSatang));
    setItems(preset.items.length > 0 ? [...preset.items] : menus.length > 0 ? [{ menuId: menus[0].id, quantity: 1 }] : []);
    setNotes(preset.notes ?? "");
    setStatusMessage(null);
  }

  function closeForm() {
    setIsCreating(false);
    setEditingPreset(null);
  }

  function updateItem(index: number, patch: Partial<PricePresetItem>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function addItem() {
    if (menus.length === 0) return;
    setItems((prev) => [...prev, { menuId: menus[0].id, quantity: 1 }]);
  }

  function removeItem(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  // Calculated items total
  const itemsTotalSatang = items.reduce((sum, item) => {
    const menu = menuMap.get(item.menuId);
    return sum + (menu ? menu.price * item.quantity : 0);
  }, 0);

  const deliverySatang = fulfillment === "delivery" ? tryBahtToSatang(deliveryFeeBaht) ?? 0 : 0;
  const calculatedTotalSatang = itemsTotalSatang + deliverySatang;
  const targetSatang = tryBahtToSatang(amountBaht) ?? 0;
  const isMatch = targetSatang > 0 && calculatedTotalSatang === targetSatang;

  // Auto-fill target amount from calculated total
  function syncTargetToCalculated() {
    setAmountBaht(satangToBahtInput(calculatedTotalSatang));
  }

  async function handleSavePreset(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setStatusMessage({ ok: false, text: "กรุณาระบุชื่อสูตร" });
      return;
    }
    const finalAmountSatang = tryBahtToSatang(amountBaht);
    if (!finalAmountSatang || finalAmountSatang <= 0) {
      setStatusMessage({ ok: false, text: "ยอดเงินต้องมากกว่า 0 บาท" });
      return;
    }
    if (items.length === 0) {
      setStatusMessage({ ok: false, text: "ต้องมีรายการเมนูอย่างน้อย 1 รายการ" });
      return;
    }

    const newPreset: PricePreset = {
      id: editingPreset ? editingPreset.id : crypto.randomUUID(),
      name: name.trim(),
      amountSatang: finalAmountSatang,
      fulfillment,
      deliveryChargedSatang: deliverySatang,
      items: items.filter((it) => it.menuId && it.quantity > 0),
      notes: notes.trim() || undefined,
    };

    let updatedList: PricePreset[];
    if (editingPreset) {
      updatedList = presets.map((p) => (p.id === editingPreset.id ? newPreset : p));
    } else {
      updatedList = [...presets, newPreset];
    }

    // Sort by amount ascending
    updatedList.sort((a, b) => a.amountSatang - b.amountSatang);

    setSaving(true);
    setStatusMessage(null);
    try {
      const res = await saveAllPricePresets(updatedList);
      if (res.ok) {
        setPresets(updatedList);
        closeForm();
        setStatusMessage({ ok: true, text: "บันทึกสูตรเรียบร้อยแล้ว" });
      } else {
        setStatusMessage({ ok: false, text: res.error ?? "บันทึกไม่สำเร็จ" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการบันทึก";
      setStatusMessage({ ok: false, text: msg });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string, presetName: string) {
    if (!window.confirm(`คุณต้องการลบสูตร "${presetName}" ใช่หรือไม่?`)) return;
    const updatedList = presets.filter((p) => p.id !== id);
    setSaving(true);
    try {
      const res = await saveAllPricePresets(updatedList);
      if (res.ok) {
        setPresets(updatedList);
        if (editingPreset?.id === id) closeForm();
        setStatusMessage({ ok: true, text: "ลบสูตรเรียบร้อยแล้ว" });
      } else {
        setStatusMessage({ ok: false, text: res.error ?? "ลบไม่สำเร็จ" });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel settings-card preset-manager-panel">
      <div className="preset-card-head">
        <div>
          <h2>สูตรเปิดบิลด่วนตามยอดเงิน (Price Presets)</h2>
          <p className="field-hint">
            ตั้งค่ายอดเงินยอดฮิตในสลิป (เช่น 84 บ., 114 บ.) เพื่อให้อ่านสลิปแล้วจับคู่เมนูและค่าส่งให้อัตโนมัติ
          </p>
        </div>
        {!isCreating && !editingPreset && (
          <button type="button" className="primary-button preset-add-btn" onClick={openCreate}>
            <Plus size={16} /> เพิ่มสูตรใหม่
          </button>
        )}
      </div>

      {statusMessage && (
        <div className={statusMessage.ok ? "success-toast" : "error-toast"} style={{ margin: "12px 0" }}>
          {statusMessage.text}
        </div>
      )}

      {/* Preset List */}
      <div className="preset-list">
        {presets.length === 0 ? (
          <div className="empty-state" style={{ padding: "20px 0" }}>
            ยังไม่มีสูตรเปิดบิลด่วน — กดปุ่ม “เพิ่มสูตรใหม่” เพื่อตั้งค่ายอดเงินที่เจอบ่อย
          </div>
        ) : (
          presets.map((preset) => {
            const isDeliv = preset.fulfillment === "delivery";
            return (
              <div key={preset.id} className="preset-row-card">
                <div className="preset-row-main">
                  <div className="preset-badge">{formatBaht(preset.amountSatang)}</div>
                  <div className="preset-details">
                    <strong className="preset-name">{preset.name}</strong>
                    <div className="preset-summary-line">
                      <span className="preset-fulfillment-tag">
                        {isDeliv ? (
                          <>
                            <Bike size={13} /> ส่ง ({formatBaht(preset.deliveryChargedSatang)})
                          </>
                        ) : (
                          <>
                            <Store size={13} /> รับเอง
                          </>
                        )}
                      </span>
                      <span className="preset-items-text">
                        {preset.items
                          .map((it) => {
                            const m = menuMap.get(it.menuId);
                            return m ? `${m.name} × ${it.quantity}` : null;
                          })
                          .filter(Boolean)
                          .join(", ")}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="preset-row-actions">
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => openEdit(preset)}
                    aria-label={`แก้ไข ${preset.name}`}
                  >
                    <Edit2 size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() => handleDelete(preset.id, preset.name)}
                    aria-label={`ลบ ${preset.name}`}
                    disabled={saving}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Create / Edit Form Modal / Card */}
      {(isCreating || editingPreset) && (
        <form onSubmit={handleSavePreset} className="preset-editor-form">
          <div className="preset-editor-head">
            <h3>{editingPreset ? `แก้ไขสูตร: ${editingPreset.name}` : "สร้างสูตรเปิดบิลด่วนใหม่"}</h3>
            <button type="button" className="icon-button" onClick={closeForm} aria-label="ปิด">
              <X size={18} />
            </button>
          </div>

          <div className="preset-form-grid">
            <label>
              ชื่อสูตร (สำหรับจำง่าย)
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="เช่น ชุดไข่ต้ม 9 ฟอง + ส่ง 15 บ."
                required
                maxLength={80}
              />
            </label>

            <label>
              ยอดเงินในสลิป (บาท)
              <div className="amount-input-wrap">
                <input
                  type="text"
                  inputMode="decimal"
                  value={amountBaht}
                  onChange={(e) => setAmountBaht(e.target.value)}
                  placeholder="เช่น 84"
                  required
                />
                {calculatedTotalSatang > 0 && targetSatang !== calculatedTotalSatang && (
                  <button
                    type="button"
                    className="chip-btn"
                    style={{ fontSize: 12, padding: "2px 8px" }}
                    onClick={syncTargetToCalculated}
                  >
                    ใช้ยอดคำนวณ ({formatBaht(calculatedTotalSatang, false)})
                  </button>
                )}
              </div>
            </label>
          </div>

          <div className="preset-form-section">
            <span className="field-label">รูปแบบการรับ</span>
            <div className="segmented" role="radiogroup">
              <button
                type="button"
                role="radio"
                aria-checked={fulfillment === "pickup"}
                className={fulfillment === "pickup" ? "active" : ""}
                onClick={() => setFulfillment("pickup")}
              >
                <Store size={15} /> รับเอง
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={fulfillment === "delivery"}
                className={fulfillment === "delivery" ? "active" : ""}
                onClick={() => setFulfillment("delivery")}
              >
                <Bike size={15} /> ส่ง
              </button>
            </div>
            {fulfillment === "delivery" && (
              <label style={{ marginTop: "10px" }}>
                ค่าส่งที่เรียกเก็บ (บาท)
                <input
                  inputMode="decimal"
                  value={deliveryFeeBaht}
                  onChange={(e) => setDeliveryFeeBaht(e.target.value)}
                  placeholder="15"
                />
                <div className="tip-chips" style={{ marginTop: "6px" }}>
                  {feeOptions.map((optSatang) => (
                    <button
                      key={optSatang}
                      type="button"
                      className={`chip-btn ${deliverySatang === optSatang ? "round-up" : ""}`}
                      onClick={() => setDeliveryFeeBaht(satangToBahtInput(optSatang))}
                    >
                      {formatBaht(optSatang, false)} ฿
                    </button>
                  ))}
                </div>
              </label>
            )}
          </div>

          <div className="preset-form-section">
            <div className="preset-section-head">
              <span className="field-label">รายการเมนูในชุด</span>
              <button type="button" className="link-button" onClick={addItem}>
                <Plus size={14} /> เพิ่มเมนู
              </button>
            </div>

            <div className="preset-items-builder">
              {items.map((item, idx) => {
                const currentMenu = menuMap.get(item.menuId);
                return (
                  <div key={idx} className="preset-item-builder-row">
                    <select
                      value={item.menuId}
                      onChange={(e) => updateItem(idx, { menuId: e.target.value })}
                      className="preset-menu-select"
                    >
                      {menus.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} ({formatBaht(m.price)})
                        </option>
                      ))}
                    </select>

                    <div className="preset-item-qty-wrap">
                      <span>จำนวน:</span>
                      <input
                        type="number"
                        min="1"
                        max="99"
                        value={item.quantity}
                        onChange={(e) => updateItem(idx, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                        style={{ width: "60px", textAlign: "center" }}
                      />
                    </div>

                    <span className="preset-item-line-price">
                      {currentMenu ? formatBaht(currentMenu.price * item.quantity) : "—"}
                    </span>

                    {items.length > 1 && (
                      <button
                        type="button"
                        className="icon-button danger"
                        onClick={() => removeItem(idx)}
                        aria-label="ลบรายการนี้"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Real-time live check bar */}
          <div className={`preset-live-check ${isMatch ? "is-match" : "is-mismatch"}`}>
            <div className="check-info">
              <span>
                รวมเมนู {formatBaht(itemsTotalSatang)}
                {fulfillment === "delivery" ? ` + ค่าส่ง ${formatBaht(deliverySatang)}` : ""} ={" "}
                <strong>{formatBaht(calculatedTotalSatang)}</strong>
              </span>
              <small>
                {isMatch ? (
                  <span className="tag-ok">
                    <Check size={13} style={{ display: "inline", verticalAlign: "-2px" }} /> ตรงกับยอดสลิปพอดี (
                    {formatBaht(targetSatang)})
                  </span>
                ) : (
                  <span className="tag-warn">
                    ยอดรวม ({formatBaht(calculatedTotalSatang)}) ต่างจากยอดสลิป ({formatBaht(targetSatang)})
                  </span>
                )}
              </small>
            </div>
          </div>

          <div className="preset-editor-actions">
            <button type="button" className="secondary-button" onClick={closeForm}>
              ยกเลิก
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? "กำลังบันทึก…" : "บันทึกสูตร"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
