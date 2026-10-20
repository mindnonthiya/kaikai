"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bike, Check, ImagePlus, Minus, Plus, RotateCcw, ShieldCheck, Sparkles, Store, Trash2, X } from "lucide-react";
import { defaultOrderPackaging, packagingLinesCost } from "@/lib/analytics";
import type { Fulfillment, PricePreset } from "@/lib/data/types";
import { calculateSale, formatBaht, formatUnitCost, tryBahtToSatang } from "@/lib/money";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";
import { compressSlipImage } from "@/lib/image-compression";
import { fromBangkokDateTimeInput, toBangkokDateTimeInput } from "@/lib/time";

type Cart = Record<string, number>;
type PaymentStatus = "paid" | "partial" | "unpaid";
export type CustomItem = {
  id: string;
  name: string;
  price: number; // satang
  cost: number;  // satang
  quantity: number;
};
export type MenuOption = {
  id: string; name: string; price: number; imagePath?: string | null; category: string; isAddon: boolean; isService?: boolean;
  /** Cost per dish without packaging, including the pooled-ingredient %. */
  foodCost: number;
  /** Default packaging per dish (from the menu's recipe). */
  packaging: Array<{ packagingId: string; quantity: number }>;
};
export type PackagingOption = { id: string; name: string; unit: string; unitCost: number };

const SLIP_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_SLIP_BYTES = 10 * 1024 * 1024;

/** Checks the file's first bytes, not just its name/MIME, so renamed files are rejected. */
async function hasImageSignature(file: File) {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isJpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const isWebp = String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP";
  return isJpeg || isPng || isWebp;
}

async function sha256Hex(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function SaleComposer({ menus, packaging, defaultDeliveryFee, pooledBps, showMenuImages = true, presets = [] }: {
  menus: MenuOption[]; packaging: PackagingOption[]; defaultDeliveryFee: number; pooledBps: number; showMenuImages?: boolean; presets?: PricePreset[];
}) {
  const router = useRouter();
  const defaultDelivery = formatBaht(defaultDeliveryFee, false);

  const [cart, setCart] = useState<Cart>({});
  const [customItems, setCustomItems] = useState<CustomItem[]>([]);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customCost, setCustomCost] = useState("");

  /** Seller's +/− on top of the automatic packaging count, per packaging id. */
  const [adjust, setAdjust] = useState<Record<string, number>>({});
  const [fulfillment, setFulfillment] = useState<Fulfillment>("pickup");
  const [delivery, setDelivery] = useState(defaultDelivery);
  const [discount, setDiscount] = useState("0");
  const [tip, setTip] = useState("0");
  const [fee, setFee] = useState("0");
  const [payment, setPayment] = useState("transfer");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("paid");
  const [paidAmount, setPaidAmount] = useState("");
  const [customer, setCustomer] = useState("");
  const [soldAt, setSoldAt] = useState(() => toBangkokDateTimeInput());
  const [slip, setSlip] = useState<File | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string; saleId?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const dishes = menus.filter((m) => !m.isAddon && !m.isService);
  const addons = menus.filter((m) => m.isAddon);
  const services = menus.filter((m) => m.isService);
  const selected = menus.filter((menu) => cart[menu.id]);

  // Packaging: automatic count from the menus' recipes (dishes vs add-ons, larger of the two), plus the seller's adjustments.
  const autoPack = defaultOrderPackaging(selected.map((m) => ({ quantity: cart[m.id], isAddon: m.isAddon || m.isService, packaging: m.packaging })));
  const packLines = packaging.map((p) => {
    const auto = autoPack.get(p.id) ?? 0;
    return { ...p, auto, quantity: Math.max(0, auto + (adjust[p.id] ?? 0)) };
  });
  const packagingCost = packagingLinesCost(packLines);
  const adjusted = packLines.some((l) => l.quantity !== l.auto);

  const discountSatang = tryBahtToSatang(discount);
  const deliverySatang = fulfillment === "delivery" ? tryBahtToSatang(delivery) : 0;
  const tipSatang = tryBahtToSatang(tip);
  const feeSatang = tryBahtToSatang(fee);
  const paidSatang = tryBahtToSatang(paidAmount);
  const inputError = discountSatang === null
    ? "ส่วนลดไม่ถูกต้อง"
    : deliverySatang === null
    ? "ค่าส่งไม่ถูกต้อง"
    : tipSatang === null
    ? "ทิปไม่ถูกต้อง"
    : feeSatang === null
    ? "ค่าธรรมเนียมไม่ถูกต้อง"
    : null;

  const regularItems = selected.map((menu) => ({ unitPrice: menu.price, unitCost: menu.foodCost, quantity: cart[menu.id] }));
  const customSaleItems = customItems.map((c) => ({ unitPrice: c.price, unitCost: c.cost, quantity: c.quantity }));
  const items = [...regularItems, ...customSaleItems];
  const calcItems = items.length > 0
    ? items
    : (deliverySatang && deliverySatang > 0) || (tipSatang && tipSatang > 0)
    ? [{ unitPrice: 0, unitCost: 0, quantity: 1 }]
    : [];

  let summary = { productRevenue: 0, netRevenue: 0, cogs: 0, grossProfit: 0, boxes: 0, marginBasisPoints: 0 };
  let summaryError: string | null = inputError;
  if (calcItems.length && !inputError) {
    try {
      summary = calculateSale({
        items: calcItems,
        discount: discountSatang!,
        deliveryCharged: deliverySatang!,
        tip: tipSatang!,
        paymentFee: feeSatang!,
        packagingCost,
      });
      if (items.length === 0) summary.boxes = 0;
    } catch (error) {
      summaryError = error instanceof Error ? error.message : "คำนวณยอดไม่ได้";
    }
  }
  const boxes = selected.filter((m) => !m.isAddon && !m.isService).reduce((n, m) => n + cart[m.id], 0);
  // What the customer pays = food − discount + delivery + tip
  const baseDue = summary.productRevenue - (discountSatang ?? 0) + (deliverySatang ?? 0);
  const amountDue = baseDue + (tipSatang ?? 0);
  const paymentAmount = paymentStatus === "paid" ? amountDue : paymentStatus === "unpaid" ? 0 : (paidSatang ?? 0);
  const partialError = paymentStatus === "partial" && (paidSatang === null || paidSatang <= 0 || paidSatang >= amountDue) ? "ยอดที่รับแล้วต้องมากกว่า 0 และน้อยกว่ายอดที่ต้องรับ" : null;

  // Smart round up target (e.g. 135 -> 150)
  const roundStepSatang = baseDue > 20000 ? 10000 : 5000;
  const nextRoundSatang = Math.ceil((baseDue + 100) / roundStepSatang) * roundStepSatang;
  const roundUpDiffSatang = Math.max(0, nextRoundSatang - baseDue);

  const change = (id: string, amount: number) => setCart((current) => ({ ...current, [id]: Math.max(0, (current[id] || 0) + amount) }));
  const changePack = (id: string, delta: number) => setAdjust((current) => {
    const auto = autoPack.get(id) ?? 0;
    const next = Math.max(0, Math.max(0, auto + (current[id] ?? 0)) + delta);
    return { ...current, [id]: next - auto };
  });

  function addTipQuick(deltaSatang: number) {
    const current = tryBahtToSatang(tip) ?? 0;
    const next = current + deltaSatang;
    setTip(formatBaht(next, false));
  }

  function addCustomItem() {
    const name = customName.trim();
    const priceSatang = tryBahtToSatang(customPrice);
    const costSatang = customCost.trim() ? (tryBahtToSatang(customCost) ?? 0) : 0;
    if (!name) return;
    if (priceSatang === null || priceSatang < 0) return;
    if (costSatang < 0) return;
    const newItem: CustomItem = {
      id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      price: priceSatang,
      cost: costSatang,
      quantity: 1,
    };
    setCustomItems((prev) => [...prev, newItem]);
    setCustomName("");
    setCustomPrice("");
    setCustomCost("");
    setShowCustomForm(false);
  }

  function updateCustomQty(id: string, delta: number) {
    setCustomItems((prev) =>
      prev
        .map((item) => (item.id === id ? { ...item, quantity: item.quantity + delta } : item))
        .filter((item) => item.quantity > 0)
    );
  }

  function removeCustomItem(id: string) {
    setCustomItems((prev) => prev.filter((item) => item.id !== id));
  }

  async function chooseSlip(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    if (!SLIP_TYPES[file.type]) return setResult({ ok: false, text: "รองรับเฉพาะไฟล์ JPG, PNG หรือ WebP" });
    if (file.size > MAX_SLIP_BYTES) return setResult({ ok: false, text: "ไฟล์สลิปต้องไม่เกิน 10 MB" });

    try {
      setResult({ ok: true, text: "กำลังบีบอัดรูปและอ่านข้อมูลสลิป…" });
      const compressed = await compressSlipImage(file, { maxWidth: 720, quality: 0.65 });
      setSlip(compressed.file);

      // Analyze slip via API
      const formData = new FormData();
      formData.append("file", compressed.file);
      formData.append("hash", compressed.hash);

      const res = await fetch("/api/slip/analyze", { method: "POST", body: formData });
      const json = await res.json();

      if (json.isDuplicate) {
        setResult({
          ok: false,
          text: json.duplicateReason
            ? `${json.duplicateReason} — ตรวจสอบว่าไม่ได้บันทึกซ้ำ`
            : `สลิปนี้เคยใช้แล้ว (บิล #${json.duplicateSaleNumber ?? "เดิม"}) — ตรวจสอบว่าไม่ได้บันทึกซ้ำ`,
        });
        return;
      }

      if (json.ok && json.result?.amountSatang) {
        const amtSatang = json.result.amountSatang;
        const matched = presets.find((p) => p.amountSatang === amtSatang);

        if (matched) {
          const newCart: Cart = {};
          for (const it of matched.items) {
            newCart[it.menuId] = it.quantity;
          }
          setCart(newCart);
          setFulfillment(matched.fulfillment);
          if (matched.fulfillment === "delivery") {
            setDelivery(formatBaht(matched.deliveryChargedSatang, false));
          }
          let presetItemsTotal = 0;
          for (const it of matched.items) {
            const m = menus.find((menu) => menu.id === it.menuId);
            if (m) presetItemsTotal += m.price * it.quantity;
          }
          const deliveryFee = matched.fulfillment === "delivery" ? matched.deliveryChargedSatang : 0;
          const diff = amtSatang - (presetItemsTotal + deliveryFee);
          if (diff > 0) {
            setTip(formatBaht(diff, false));
          } else {
            setTip("0");
          }
          setResult({
            ok: true,
            text: `ตรวจพบยอด ${formatBaht(amtSatang)} · จับคู่สูตร "${matched.name}" ให้อัตโนมัติ${diff > 0 ? ` (ทิป/โอนเกิน +${formatBaht(diff)})` : ""} (สลิปบีบอัดเหลือ ${(compressed.compressedBytes / 1024).toFixed(0)} KB)`,
          });
        } else {
          let cartFoodTotal = 0;
          for (const m of selected) {
            cartFoodTotal += m.price * (cart[m.id] ?? 0);
          }
          const delFee = fulfillment === "delivery" ? (tryBahtToSatang(delivery) ?? 0) : 0;
          const diff = amtSatang - (cartFoodTotal + delFee);
          if (cartFoodTotal > 0 && diff > 0) {
            setTip(formatBaht(diff, false));
          }
          setResult({
            ok: true,
            text: `ตรวจพบยอดเงิน ${formatBaht(amtSatang)} ในสลิป${cartFoodTotal > 0 && diff > 0 ? ` (คำนวณทิปให้อัตโนมัติ +${formatBaht(diff)})` : ""} (บีบอัดเหลือ ${(compressed.compressedBytes / 1024).toFixed(0)} KB)`,
          });
        }
      } else {
        setResult({
          ok: true,
          text: `แนบสลิปเรียบร้อย (${(compressed.compressedBytes / 1024).toFixed(0)} KB · บีบอัดเพื่อประหยัดพื้นที่)`,
        });
      }
    } catch (err: unknown) {
      console.error("Slip compression/analysis error:", err);
      setSlip(file);
      setResult(null);
    }
  }


  function resetForm() {
    setCart({}); setAdjust({}); setCustomItems([]); setShowCustomForm(false);
    setFulfillment("pickup"); setDelivery(defaultDelivery); setDiscount("0"); setTip("0"); setFee("0");
    setPaymentStatus("paid"); setPaidAmount(""); setCustomer(""); setSlip(null);
    setSoldAt(toBangkokDateTimeInput());
  }

  async function save() {
    setResult(null);
    if (summaryError || partialError) return setResult({ ok: false, text: summaryError ?? partialError! });
    if (!hasSupabaseEnv) return setResult({ ok: false, text: "ยังไม่ได้เชื่อม Supabase จึงบันทึกไม่ได้" });
    setSaving(true);
    const supabase = createClient();
    let slipPayload: Record<string, unknown> | undefined;
    let uploadedPath: string | null = null;
    try {
      if (slip && payment === "transfer") {
        if (!(await hasImageSignature(slip))) throw new Error("ไฟล์สลิปไม่ใช่รูปภาพที่ถูกต้อง");
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่");
        const hash = await sha256Hex(slip);
        uploadedPath = `${user.id}/${crypto.randomUUID()}.${SLIP_TYPES[slip.type]}`;
        const { error: uploadError } = await supabase.storage.from("sale-slips").upload(uploadedPath, slip, { contentType: slip.type, upsert: false });
        if (uploadError) { uploadedPath = null; throw new Error(`อัปโหลดสลิปไม่สำเร็จ: ${uploadError.message}`); }
        slipPayload = { storage_path: uploadedPath, mime_type: slip.type, size_bytes: slip.size, file_hash_sha256: hash };
      }

      const notesParts = [
        tipSatang && tipSatang > 0 ? `ทิป/โอนเกิน ${formatBaht(tipSatang)}` : null,
        customItems.length ? `รายการพิเศษ: ${customItems.map((c) => `${c.name} x${c.quantity}`).join(", ")}` : null,
      ].filter(Boolean);

      const { data, error } = await supabase.rpc("create_sale", { payload: {
        items: selected.map((menu) => ({ menu_id: menu.id, quantity: cart[menu.id] })),
        custom_items: customItems.map((c) => ({
          name: c.name,
          price_satang: c.price,
          cost_satang: c.cost,
          quantity: c.quantity,
        })),
        packaging: packLines.filter((l) => l.quantity > 0).map((l) => ({ packaging_item_id: l.id, quantity: l.quantity })),
        fulfillment,
        pooled_ingredient_bps: pooledBps,
        discount_satang: discountSatang,
        delivery_charged_satang: deliverySatang,
        tip_satang: tipSatang,
        payment_fee_satang: feeSatang,
        payment_amount_satang: paymentAmount,
        payment_method: payment,
        payment_status: paymentStatus,
        customer_name: customer.trim() || null,
        sold_at: fromBangkokDateTimeInput(soldAt),
        notes: notesParts.join(" · ") || null,
        ...(slipPayload ? { slip: slipPayload } : {}),
      } });

      if (error) {
        if (error.message.includes("slip_uploads_owner_id_file_hash_sha256_key")) throw new Error("สลิปนี้เคยแนบกับรายการอื่นแล้ว — ตรวจสอบว่าไม่ได้บันทึกซ้ำ");
        if (error.message.includes("menu unavailable")) throw new Error("มีเมนูที่ถูกปิดการขายหรือถูกลบไปแล้ว กรุณารีเฟรชหน้า");
        if (error.message.includes("packaging not found")) throw new Error("มีบรรจุภัณฑ์ที่ถูกลบไปแล้ว กรุณารีเฟรชหน้า");
        throw new Error(`บันทึกไม่สำเร็จ: ${error.message}`);
      }
      const saleId = String((data as { sale_id?: string })?.sale_id ?? "");
      setResult({ ok: true, text: `บันทึกแล้ว · ยอด ${formatBaht(summary.netRevenue)} · กำไรขั้นต้น ${formatBaht(summary.grossProfit)}`, saleId });
      resetForm();
      router.refresh();
    } catch (error) {
      if (uploadedPath) await supabase.storage.from("sale-slips").remove([uploadedPath]);
      setResult({ ok: false, text: error instanceof Error ? error.message : "บันทึกไม่สำเร็จ" });
    } finally {
      setSaving(false);
    }
  }

  const hasItemsOrService = items.length > 0 || (deliverySatang && deliverySatang > 0) || (tipSatang && tipSatang > 0);
  let step = 1;
  return <div className="sale-composer">
    <div className="sales-mode-bar" style={{ gridColumn: "1 / -1" }}>
      <div className="sales-mode-tabs">
        <span className="sales-mode-tab active">
          เปิดบิลเดี่ยว
        </span>
        <Link href="/sales/import-slips" className="sales-mode-tab">
          นำเข้าสลิปเป็นชุด
        </Link>
      </div>
    </div>
    <section className="composer-main">
      <div className="step-head">
        <span>{step++}</span>
        <div>
          <h2>เลือกรายการ</h2>
          <p>แตะที่รายการเพื่อเพิ่มจำนวน หรือกดปุ่ม +/-</p>
        </div>
      </div>

      {/* 1. เมนูหลัก (อาหาร) */}
      <div className="pos-section">
        <h3 className="pos-section-title">เมนูหลัก (อาหาร)</h3>
        <div className="pos-grid">
          {dishes.map((menu) => (
            <PosMenuCard key={menu.id} menu={menu} count={cart[menu.id] ?? 0} showImages={showMenuImages} onChange={change} />
          ))}
          {!dishes.length && <div className="empty-state">ยังไม่มีเมนูหลัก — <Link href="/menus" className="text-link">สร้างเมนูก่อน</Link></div>}
        </div>
      </div>

      {/* 2. ของเพิ่ม */}
      {addons.length > 0 && (
        <div className="pos-section">
          <h3 className="pos-section-title">ของเพิ่ม</h3>
          <div className="pos-grid">
            {addons.map((menu) => (
              <PosMenuCard key={menu.id} menu={menu} count={cart[menu.id] ?? 0} showImages={showMenuImages} onChange={change} />
            ))}
          </div>
        </div>
      )}

      {/* 3. จ็อบเสริม / บริการ (รายการประจำ) */}
      <div className="pos-section">
        <div className="pos-section-head">
          <h3 className="pos-section-title">จ็อบเสริม / บริการ (รายการประจำ)</h3>
          <Link href="/menus" className="pos-add-service-link">
            + ตั้งค่าจ็อบประจำ
          </Link>
        </div>
        {services.length > 0 ? (
          <div className="pos-grid">
            {services.map((menu) => (
              <PosMenuCard key={menu.id} menu={menu} count={cart[menu.id] ?? 0} showImages={showMenuImages} onChange={change} />
            ))}
          </div>
        ) : (
          <p className="pos-service-hint">
            ยังไม่มีรายการจ็อบเสริมประจำ (สามารถสร้างไว้ที่หน้า <Link href="/menus" className="text-link">เมนู</Link> แล้วเลือกประเภท “จ็อบเสริม / บริการ” เช่น mj ส่งด่วน, ค่าหิ้ว จะมาแสดงตรงนี้ตลอดโดยไม่ต้องพิมพ์ใหม่)
          </p>
        )}
      </div>

      {/* 4. รายการพิเศษเฉพาะบิลนี้ (ครั้งคราว) */}
      {customItems.length > 0 && (
        <div className="pos-section">
          <h3 className="pos-section-title">รายการพิเศษชั่วคราว (เฉพาะบิลนี้)</h3>
          <div className="pos-grid">
            {customItems.map((item) => (
              <div key={item.id} className="pos-menu-card is-custom is-selected no-image">
                <div className="pos-card-body">
                  <div className="pos-card-info">
                    <strong className="pos-card-title">{item.name}</strong>
                    <span className="pos-card-price">
                      {formatBaht(item.price)}
                      {item.cost > 0 && <small className="pos-card-cost"> (ทุน {formatBaht(item.cost)})</small>}
                    </span>
                  </div>
                  <div className="pos-card-controls">
                    <div className="pos-stepper">
                      <button type="button" className="pos-stepper-btn minus" onClick={() => updateCustomQty(item.id, -1)} aria-label={`ลด ${item.name}`}><Minus size={16} /></button>
                      <span className="pos-stepper-count">{item.quantity}</span>
                      <button type="button" className="pos-stepper-btn plus" onClick={() => updateCustomQty(item.id, 1)} aria-label={`เพิ่ม ${item.name}`}><Plus size={16} /></button>
                      <button type="button" className="pos-stepper-btn remove" onClick={() => removeCustomItem(item.id)} aria-label="ลบรายการ"><Trash2 size={16} /></button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showCustomForm ? (
        <div className="custom-item-card" style={{ marginTop: "16px" }}>
          <h4>เพิ่มรายการด่วนพิเศษเฉพาะบิลนี้ (ครั้งคราว)</h4>
          <div className="custom-item-grid">
            <label>ชื่อรายการ<input value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="เช่น ฝากซื้อน้ำอัดลม, ค่าของฝาก" autoFocus maxLength={120} /></label>
            <label>ราคาขาย (บาท)<input inputMode="decimal" value={customPrice} onChange={(e) => setCustomPrice(e.target.value)} placeholder="เช่น 40" /></label>
            <label>ต้นทุน (บาท)<input inputMode="decimal" value={customCost} onChange={(e) => setCustomCost(e.target.value)} placeholder="0 (เว้นว่างได้)" /></label>
          </div>
          <div className="custom-item-actions">
            <button type="button" className="link-button" onClick={() => { setShowCustomForm(false); setCustomName(""); setCustomPrice(""); setCustomCost(""); }}>ยกเลิก</button>
            <button type="button" className="primary-button" style={{ minHeight: 38, padding: "0 14px", fontSize: 13 }} onClick={addCustomItem} disabled={!customName.trim() || tryBahtToSatang(customPrice) === null}>+ เพิ่มลงบิล</button>
          </div>
        </div>
      ) : (
        <button type="button" className="add-custom-trigger" style={{ marginTop: "14px" }} onClick={() => setShowCustomForm(true)}>
          <Plus size={16} /> มีรายการพิเศษจร/ฝากซื้อเฉพาะบิลนี้ (ครั้งคราว)
        </button>
      )}

      {packaging.length > 0 && <>
        <div className="step-head second"><span>{step++}</span><div><h2>บรรจุภัณฑ์</h2><p>นับจากเมนูให้แล้ว — กด +/− ถ้าให้ไม่ตรง เช่น ให้ช้อนเพิ่ม</p></div>{adjusted && <button type="button" className="link-button" onClick={() => setAdjust({})}><RotateCcw size={14} /> คืนค่าอัตโนมัติ</button>}</div>
        <div className="pack-list">{packLines.map((line) => <div key={line.id} className={`pack-row ${line.quantity ? "" : "is-zero"}`}>
          <span><strong>{line.name}</strong><small>{formatUnitCost(line.unitCost)}/{line.unit}{line.quantity !== line.auto ? ` · อัตโนมัติ ${line.auto}` : ""}</small></span>
          <div className="qty"><button type="button" onClick={() => changePack(line.id, -1)} aria-label={`ลด ${line.name}`} disabled={!line.quantity}><Minus size={16} /></button><b>{line.quantity}</b><button type="button" onClick={() => changePack(line.id, 1)} aria-label={`เพิ่ม ${line.name}`}><Plus size={16} /></button></div>
        </div>)}</div>
      </>}

      <div className="step-head second"><span>{step++}</span><div><h2>รับเอง / ส่ง และการชำระ</h2><p>ค่าส่งเป็นรายได้ของร้าน · ค่าน้ำมันลงในหน้าค่าใช้จ่าย</p></div></div>
      <div className="segmented" role="radiogroup" aria-label="รับเองหรือส่ง">
        <button type="button" role="radio" aria-checked={fulfillment === "pickup"} className={fulfillment === "pickup" ? "active" : ""} onClick={() => setFulfillment("pickup")}><Store size={17} /> รับเอง</button>
        <button type="button" role="radio" aria-checked={fulfillment === "delivery"} className={fulfillment === "delivery" ? "active" : ""} onClick={() => setFulfillment("delivery")}><Bike size={17} /> ส่ง</button>
      </div>
      <div className="form-grid">
        {fulfillment === "delivery" && <label>ค่าส่ง (บาท)<input id="sale-delivery" inputMode="decimal" value={delivery} onChange={(e) => setDelivery(e.target.value)} aria-invalid={deliverySatang === null} /></label>}
        <div className="tip-input-wrap">
          <div className="label-row">
            <label htmlFor="sale-tip">ทิป / ลูกค้าโอนเกิน (บาท)</label>
            {roundUpDiffSatang > 0 && (
              <button type="button" className="chip-btn round-up" onClick={() => setTip(formatBaht(roundUpDiffSatang, false))}>
                <Sparkles size={12} style={{ display: "inline", verticalAlign: "-1px", marginRight: 3 }} />
                ปัดเศษเป็น {formatBaht(nextRoundSatang, false)} (+{formatBaht(roundUpDiffSatang, false)})
              </button>
            )}
          </div>
          <div className="tip-input-group">
            <input id="sale-tip" inputMode="decimal" value={tip} onChange={(e) => setTip(e.target.value)} aria-invalid={tipSatang === null} placeholder="0" />
            <div className="tip-chips">
              <button type="button" className="chip-btn" onClick={() => addTipQuick(1000)}>+10</button>
              <button type="button" className="chip-btn" onClick={() => addTipQuick(2000)}>+20</button>
              <button type="button" className="chip-btn" onClick={() => addTipQuick(5000)}>+50</button>
              {tipSatang !== null && tipSatang > 0 && (
                <button type="button" className="chip-btn clear" onClick={() => setTip("0")}>ล้าง</button>
              )}
            </div>
          </div>
        </div>
        <label>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>วันที่และเวลาที่ขาย</span>
            <button
              type="button"
              className="text-link"
              style={{ fontSize: "11px", fontWeight: "normal", background: "none", border: "none", cursor: "pointer", color: "var(--primary-dark)" }}
              onClick={() => setSoldAt(toBangkokDateTimeInput())}
            >
              ตอนนี้
            </button>
          </div>
          <input
            id="sale-sold-at"
            type="datetime-local"
            value={soldAt}
            onChange={(e) => setSoldAt(e.target.value)}
          />
        </label>
        <label>ช่องทางชำระ<select id="sale-payment-method" value={payment} onChange={(e) => setPayment(e.target.value)}><option value="transfer">เงินโอน</option><option value="cash">เงินสด</option><option value="other">อื่น ๆ</option></select></label>
        <label>ชื่อลูกค้า (ไม่บังคับ)<input id="sale-customer" value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={120} placeholder="เช่น คุณเมย์" /></label>
        <label>สถานะการรับเงิน<select id="sale-payment-status" value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as PaymentStatus)}><option value="paid">ชำระครบแล้ว</option><option value="partial">ชำระบางส่วน</option><option value="unpaid">ยังไม่ชำระ</option></select></label>
        {paymentStatus === "partial" && <label>ยอดที่รับแล้ว (บาท)<input id="sale-paid-amount" inputMode="decimal" value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} placeholder={`น้อยกว่า ${formatBaht(amountDue, false)}`} aria-invalid={!!partialError} /></label>}
        <label>ส่วนลด (บาท)<input id="sale-discount" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} aria-invalid={discountSatang === null} /></label>
        <label>ค่าธรรมเนียมที่ร้านจ่าย (บาท)<input id="sale-fee" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} aria-invalid={feeSatang === null} /></label>
      </div>
      {payment === "transfer" && (slip
        ? <div className="slip-chosen"><ImagePlus size={18} /><span><strong>{slip.name}</strong><small>{(slip.size / 1024).toFixed(0)} KB · จะอัปโหลดเมื่อกดบันทึก</small></span><button type="button" className="icon-button" onClick={() => setSlip(null)} aria-label="เอาสลิปออก"><X size={18} /></button></div>
        : <label className="slip-drop"><input id="sale-slip" type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseSlip} /><ImagePlus /><strong>แนบสลิปการโอน (ไม่บังคับ)</strong><span>JPG, PNG หรือ WebP ไม่เกิน 10 MB</span><small>สลิปไม่ใช่หลักฐานยืนยันว่าเงินเข้าบัญชีจริง</small></label>)}
    </section>
    <aside className="order-summary"><h2>สรุปรายการ</h2>
      <div className="order-lines">
        {selected.map((menu) => <div key={menu.id}><span>{menu.name}<small>{cart[menu.id]} × {formatBaht(menu.price)}</small></span><strong>{formatBaht(menu.price * cart[menu.id])}</strong></div>)}
        {customItems.map((item) => <div key={item.id}><span>{item.name}<small>{item.quantity} × {formatBaht(item.price)}</small></span><strong>{formatBaht(item.price * item.quantity)}</strong></div>)}
      </div>
      <div className="summary-row"><span>ยอดสินค้า/บริการ</span><strong>{formatBaht(summary.productRevenue)}</strong></div>
      {fulfillment === "delivery" && <div className="summary-row"><span>ค่าส่ง</span><strong>+{formatBaht(deliverySatang ?? 0)}</strong></div>}
      {(discountSatang ?? 0) > 0 && <div className="summary-row"><span>ส่วนลด</span><strong>−{formatBaht(discountSatang!)}</strong></div>}
      {(tipSatang ?? 0) > 0 && <div className="summary-row green"><span>ทิป / ได้รับเพิ่ม</span><strong>+{formatBaht(tipSatang!)}</strong></div>}
      <div className="summary-total"><span>ยอดที่ต้องรับ (ตรงสลิป)</span><strong>{formatBaht(Math.max(0, amountDue))}</strong></div>
      {paymentStatus !== "paid" && <div className="summary-row"><span>ค้างรับ</span><strong>{formatBaht(Math.max(0, amountDue - paymentAmount))}</strong></div>}
      <div className="summary-row muted-row"><span>ต้นทุนสินค้า/วัตถุดิบ (ประมาณ)</span><strong>{formatBaht(Math.max(0, summary.cogs - packagingCost))}</strong></div>
      {packaging.length > 0 && <div className="summary-row muted-row"><span>ต้นทุนบรรจุภัณฑ์</span><strong>{formatBaht(packagingCost)}</strong></div>}
      {(feeSatang ?? 0) > 0 && <div className="summary-row muted-row"><span>ค่าธรรมเนียม</span><strong>−{formatBaht(feeSatang!)}</strong></div>}
      <div className="profit-box"><span>กำไรขั้นต้น</span><strong>{formatBaht(summary.grossProfit)}</strong><small>{(summary.marginBasisPoints / 100).toFixed(1)}% · {boxes > 0 ? `${boxes} กล่อง` : "บริการ/พิเศษ"}{fulfillment === "delivery" ? " · ส่ง" : ""}</small></div>
      {(summaryError || partialError) && <p className="form-error" role="alert">{summaryError ?? partialError}</p>}
      <button id="sale-save" className="primary-button save-sale" disabled={!hasItemsOrService || saving || !!summaryError || !!partialError} onClick={save}><Check size={18} /> {saving ? "กำลังบันทึก…" : "ยืนยันและบันทึก"}</button>
      <p className="atomic-note"><ShieldCheck size={15} /> รายการขาย บรรจุภัณฑ์ และการชำระเงินจะบันทึกพร้อมกัน</p>
      {result && <div className={result.ok ? "success-toast" : "error-toast"} role="status">{result.text}{result.ok && result.saleId && <> · <Link href="/sales" className="text-link">ดูประวัติ</Link></>}</div>}
    </aside>
  </div>;
}

/** Touch-friendly POS Menu Card: big tap area, prominent price, comfortable steppers */
function PosMenuCard({
  menu,
  count,
  showImages = true,
  onChange,
}: {
  menu: MenuOption;
  count: number;
  showImages?: boolean;
  onChange: (id: string, delta: number) => void;
}) {
  const hasImage = Boolean(showImages && menu.imagePath);

  return (
    <div
      className={`pos-menu-card ${count ? "is-selected" : ""} ${!hasImage ? "no-image" : ""}`}
      onClick={() => {
        if (count === 0) onChange(menu.id, 1);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (count === 0) onChange(menu.id, 1);
        }
      }}
    >
      {hasImage && (
        <div className="pos-card-media">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={menu.imagePath!} alt="" className="pos-card-img" loading="lazy" />
        </div>
      )}

      <div className="pos-card-body">
        <div className="pos-card-info">
          <strong className="pos-card-title">{menu.name}</strong>
          <span className="pos-card-price">{formatBaht(menu.price)}</span>
        </div>

        <div className="pos-card-controls" onClick={(e) => e.stopPropagation()}>
          {count === 0 ? (
            <button
              type="button"
              className="pos-add-btn"
              onClick={() => onChange(menu.id, 1)}
              aria-label={`เพิ่ม ${menu.name}`}
            >
              <Plus size={16} />
              <span>เพิ่ม</span>
            </button>
          ) : (
            <div className="pos-stepper">
              <button
                type="button"
                className="pos-stepper-btn minus"
                onClick={() => onChange(menu.id, -1)}
                aria-label={`ลด ${menu.name}`}
              >
                <Minus size={16} />
              </button>
              <span className="pos-stepper-count">{count}</span>
              <button
                type="button"
                className="pos-stepper-btn plus"
                onClick={() => onChange(menu.id, 1)}
                aria-label={`เพิ่ม ${menu.name}`}
              >
                <Plus size={16} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

