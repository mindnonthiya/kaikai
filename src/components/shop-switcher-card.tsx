"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Plus, Store, Trash2, ArrowRightLeft, X } from "lucide-react";
import { createShopAction, deleteShopAction, switchShopAction } from "@/app/actions/settings";
import { DEFAULT_UNIT_LABEL, UNIT_LABEL_OPTIONS } from "@/lib/data/types";
import { DEFAULT_SHOP_ID, type ShopSummary } from "@/lib/shop-scope";

export function ShopSwitcherCard({
  shops,
  activeShopId,
  email,
}: {
  shops: ShopSummary[];
  activeShopId: string;
  email: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingShopId, setPendingShopId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newShopName, setNewShopName] = useState("");
  const [newUnitLabel, setNewUnitLabel] = useState("ชิ้น");
  const [copyIngredients, setCopyIngredients] = useState(true);
  const [copyMenus, setCopyMenus] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const activeShop = shops.find((s) => s.id === activeShopId) ?? shops[0];

  function handleSwitch(targetId: string) {
    if (targetId === activeShopId || isPending) return;
    setFeedback(null);
    setPendingShopId(targetId);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("shop_id", targetId);
      const res = await switchShopAction(fd);
      setPendingShopId(null);
      if (res.ok) {
        setFeedback({ ok: true, text: res.message ?? "สลับร้านแล้ว" });
        router.refresh();
      } else {
        setFeedback({ ok: false, text: res.error ?? "สลับร้านไม่สำเร็จ" });
      }
    });
  }

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!newShopName.trim() || isPending) return;
    setFeedback(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("shop_name", newShopName.trim());
      fd.set("unit_label", newUnitLabel.trim() || DEFAULT_UNIT_LABEL);
      if (copyIngredients || copyMenus) fd.set("copy_ingredients", "true");
      if (copyMenus) fd.set("copy_menus", "true");

      const res = await createShopAction(fd);
      if (res.ok) {
        setNewShopName("");
        setNewUnitLabel("ชิ้น");
        setCopyIngredients(true);
        setCopyMenus(false);
        setShowCreateForm(false);
        setFeedback({ ok: true, text: res.message ?? "สร้างร้านใหม่แล้ว" });
        router.refresh();
      } else {
        setFeedback({ ok: false, text: res.error ?? "สร้างร้านไม่สำเร็จ" });
      }
    });
  }

  function handleDelete(shop: ShopSummary) {
    if (shop.id === DEFAULT_SHOP_ID || isPending) return;
    const confirmed = window.confirm(
      `ยืนยันการลบร้าน “${shop.shopName}” หรือไม่?\n\nข้อมูลเมนู วัตถุดิบ ออเดอร์ และรายจ่ายทั้งหมดของร้าน “${shop.shopName}” จะถูกลบอย่างถาวร (ข้อมูลของร้านอื่นจะไม่ถูกกระทบ)`,
    );
    if (!confirmed) return;

    setFeedback(null);
    setPendingShopId(shop.id);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("shop_id", shop.id);
      const res = await deleteShopAction(fd);
      setPendingShopId(null);
      if (res.ok) {
        setFeedback({ ok: true, text: res.message ?? "ลบร้านเรียบร้อยแล้ว" });
        router.refresh();
      } else {
        setFeedback({ ok: false, text: res.error ?? "ลบร้านไม่สำเร็จ" });
      }
    });
  }

  return (
    <section id="shops" className="panel settings-card shop-manager-card">
      <div className="shop-manager-head">
        <div className="shop-manager-head-text">
          <span className="shop-manager-eyebrow">1 อีเมล · หลายร้าน</span>
          <h2>สลับและจัดการร้านค้า ({shops.length} ร้าน)</h2>
          <p className="field-hint">
            บัญชี <strong>{email || "ของคุณ"}</strong> สามารถแยกบริหารหลายร้านได้อิสระ หรือกดค้างที่ปุ่ม <strong>โปรไฟล์</strong> มุมล่างขวาเพื่อสลับร้านแบบด่วนได้จากทุกหน้า
          </p>
        </div>
        {!showCreateForm && (
          <button
            type="button"
            className="primary-button shop-add-trigger-btn"
            onClick={() => {
              setFeedback(null);
              setShowCreateForm(true);
            }}
          >
            <span className="shop-add-btn-icon">
              <Plus size={15} strokeWidth={2.5} />
            </span>
            <span>เพิ่มร้านใหม่</span>
          </button>
        )}
      </div>

      {feedback && (
        <div className={`form-notice ${feedback.ok ? "ok" : "err"}`} role="status">
          {feedback.text}
        </div>
      )}

      <div className="shop-list-grid">
        {shops.map((shop) => {
          const isCurrent = shop.id === activeShopId;
          const isPrimary = shop.id === DEFAULT_SHOP_ID;
          const initial = Array.from((shop.shopName || "ร").trim())[0] ?? "ร";
          const isSwitchingThis = isPending && pendingShopId === shop.id;

          return (
            <div
              key={shop.id}
              className={`shop-item-card ${isCurrent ? "is-active" : ""}`}
              onClick={() => {
                if (!isCurrent && !isPending) handleSwitch(shop.id);
              }}
              role={!isCurrent ? "button" : undefined}
              tabIndex={!isCurrent ? 0 : undefined}
              onKeyDown={(e) => {
                if (!isCurrent && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  handleSwitch(shop.id);
                }
              }}
            >
              <div className="shop-item-main">
                <div className={`shop-item-avatar-ring ${isCurrent ? "is-active" : ""}`}>
                  <div className="shop-item-avatar">
                    {shop.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={shop.avatarUrl} alt="" className="avatar-img" />
                    ) : (
                      <span>{initial}</span>
                    )}
                  </div>
                </div>
                <div className="shop-item-info">
                  <div className="shop-item-title-row">
                    <strong>{shop.shopName}</strong>
                    {isPrimary && <span className="shop-badge primary">ร้านหลัก</span>}
                    {isCurrent && (
                      <span className="shop-badge active">
                        <Check size={12} /> กำลังใช้งาน
                      </span>
                    )}
                  </div>
                  <span className="shop-item-sub">
                    หน่วยหลัก: {shop.unitLabel || "ชิ้น"}
                    {shop.displayName && shop.displayName !== shop.shopName
                      ? ` · ${shop.displayName}`
                      : ""}
                  </span>
                </div>
              </div>

              <div className="shop-item-actions" onClick={(e) => e.stopPropagation()}>
                {isCurrent ? (
                  <span className="shop-current-indicator">
                    <i className="shop-active-dot" /> เปิดใช้งานอยู่
                  </span>
                ) : (
                  <button
                    type="button"
                    className="secondary-button shop-switch-btn"
                    onClick={() => handleSwitch(shop.id)}
                    disabled={isPending}
                  >
                    <ArrowRightLeft size={14} />
                    <span>{isSwitchingThis ? "กำลังสลับ…" : "สลับมาร้านนี้"}</span>
                  </button>
                )}

                {!isPrimary && (
                  <button
                    type="button"
                    className="icon-button danger-subtle"
                    onClick={() => handleDelete(shop)}
                    disabled={isPending}
                    title={`ลบร้าน ${shop.shopName}`}
                    aria-label={`ลบร้าน ${shop.shopName}`}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showCreateForm && (
        <form onSubmit={handleCreate} className="shop-create-panel">
          <div className="shop-create-head">
            <div className="shop-create-title">
              <Store size={18} />
              <strong>สร้างร้านใหม่ในบัญชีนี้</strong>
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowCreateForm(false)}
              aria-label="ปิดฟอร์มสร้างร้านใหม่"
            >
              <X size={16} />
            </button>
          </div>

          <div className="shop-create-fields">
            <label>
              ชื่อร้านใหม่
              <input
                type="text"
                value={newShopName}
                onChange={(e) => setNewShopName(e.target.value)}
                placeholder="เช่น ร้านอาหารตามสั่ง, ร้านเครป, ร้านน้ำ"
                maxLength={80}
                required
                autoFocus
              />
            </label>

            <label>
              คำเรียกหน่วยสินค้าหลักของร้านใหม่
              <input
                type="text"
                list="unit-label-options"
                value={newUnitLabel}
                onChange={(e) => setNewUnitLabel(e.target.value)}
                placeholder="เช่น กล่อง, จาน, แผ่น, แก้ว"
                maxLength={20}
              />
              <div className="unit-quick-chips">
                {UNIT_LABEL_OPTIONS.slice(0, 6).map((u) => (
                  <button
                    key={u}
                    type="button"
                    className={`unit-chip ${newUnitLabel === u ? "is-selected" : ""}`}
                    onClick={() => setNewUnitLabel(u)}
                  >
                    {u}
                  </button>
                ))}
              </div>
            </label>
          </div>

          <div className="shop-copy-options">
            <label className="checkbox-toggle-wrap">
              <input
                type="checkbox"
                checked={copyIngredients || copyMenus}
                disabled={copyMenus}
                onChange={(e) => setCopyIngredients(e.target.checked)}
              />
              <div>
                <strong>
                  <Copy size={13} style={{ display: "inline", verticalAlign: "-2px", marginRight: "5px" }} />
                  คัดลอกรายการวัตถุดิบและบรรจุภัณฑ์จากร้าน “{activeShop?.shopName || "ปัจจุบัน"}” ไปตั้งต้น
                </strong>
                <small className="muted-hint" style={{ display: "block", marginTop: "2px" }}>
                  ช่วยประหยัดเวลา ไม่ต้องกรอกวัตถุดิบพื้นฐานหรือกล่อง/ถุงซ้ำ (แก้ไขหรือลบแยกทีหลังได้อิสระ และไม่คัดลอกประวัติบิลซื้อ)
                </small>
              </div>
            </label>

            <label className="checkbox-toggle-wrap">
              <input
                type="checkbox"
                checked={copyMenus}
                onChange={(e) => {
                  setCopyMenus(e.target.checked);
                  if (e.target.checked) setCopyIngredients(true);
                }}
              />
              <div>
                <strong>คัดลอกเมนูและสูตรอาหารจากร้าน “{activeShop?.shopName || "ปัจจุบัน"}” ไปด้วย</strong>
                <small className="muted-hint" style={{ display: "block", marginTop: "2px" }}>
                  เหมาะสำหรับกรณีเปิดสาขาเพิ่ม หรือร้านที่มีเมนูคล้ายกัน
                </small>
              </div>
            </label>
          </div>

          <div className="shop-create-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowCreateForm(false)}
              disabled={isPending}
            >
              ยกเลิก
            </button>
            <button type="submit" className="primary-button" disabled={isPending || !newShopName.trim()}>
              {isPending ? "กำลังสร้างร้าน…" : "สร้างร้านและสลับไปร้านใหม่"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
