"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bike, Check, ImagePlus, Minus, Plus, RotateCcw, ShieldCheck, Store, X } from "lucide-react";
import { defaultOrderPackaging, packagingLinesCost } from "@/lib/analytics";
import type { Fulfillment } from "@/lib/data/types";
import { calculateSale, formatBaht, formatUnitCost, tryBahtToSatang } from "@/lib/money";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

type Cart = Record<string, number>;
type PaymentStatus = "paid" | "partial" | "unpaid";
export type MenuOption = {
  id: string; name: string; price: number; emoji: string; category: string; isAddon: boolean;
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

export function SaleComposer({ menus, packaging, defaultDeliveryFee, pooledBps }: { menus: MenuOption[]; packaging: PackagingOption[]; defaultDeliveryFee: number; pooledBps: number }) {
  const router = useRouter();
  const defaultDelivery = formatBaht(defaultDeliveryFee, false);
  const [cart, setCart] = useState<Cart>({});
  /** Seller's +/− on top of the automatic packaging count, per packaging id. */
  const [adjust, setAdjust] = useState<Record<string, number>>({});
  const [fulfillment, setFulfillment] = useState<Fulfillment>("pickup");
  const [delivery, setDelivery] = useState(defaultDelivery);
  const [discount, setDiscount] = useState("0");
  const [fee, setFee] = useState("0");
  const [payment, setPayment] = useState("transfer");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("paid");
  const [paidAmount, setPaidAmount] = useState("");
  const [customer, setCustomer] = useState("");
  const [slip, setSlip] = useState<File | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string; saleId?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const mainMenus = menus.filter((m) => !m.isAddon);
  const addons = menus.filter((m) => m.isAddon);
  const selected = menus.filter((menu) => cart[menu.id]);

  // Packaging: automatic count from the menus' recipes (dishes vs add-ons, larger of the two), plus the seller's adjustments.
  const autoPack = defaultOrderPackaging(selected.map((m) => ({ quantity: cart[m.id], isAddon: m.isAddon, packaging: m.packaging })));
  const packLines = packaging.map((p) => {
    const auto = autoPack.get(p.id) ?? 0;
    return { ...p, auto, quantity: Math.max(0, auto + (adjust[p.id] ?? 0)) };
  });
  const packagingCost = packagingLinesCost(packLines);
  const adjusted = packLines.some((l) => l.quantity !== l.auto);

  const discountSatang = tryBahtToSatang(discount);
  const deliverySatang = fulfillment === "delivery" ? tryBahtToSatang(delivery) : 0;
  const feeSatang = tryBahtToSatang(fee);
  const paidSatang = tryBahtToSatang(paidAmount);
  const inputError = discountSatang === null ? "ส่วนลดไม่ถูกต้อง" : deliverySatang === null ? "ค่าส่งไม่ถูกต้อง" : feeSatang === null ? "ค่าธรรมเนียมไม่ถูกต้อง" : null;

  const items = selected.map((menu) => ({ unitPrice: menu.price, unitCost: menu.foodCost, quantity: cart[menu.id] }));
  let summary = { productRevenue: 0, netRevenue: 0, cogs: 0, grossProfit: 0, boxes: 0, marginBasisPoints: 0 };
  let summaryError: string | null = inputError;
  if (items.length && !inputError) {
    try { summary = calculateSale({ items, discount: discountSatang!, deliveryCharged: deliverySatang!, paymentFee: feeSatang!, packagingCost }); }
    catch (error) { summaryError = error instanceof Error ? error.message : "คำนวณยอดไม่ได้"; }
  }
  const boxes = selected.filter((m) => !m.isAddon).reduce((n, m) => n + cart[m.id], 0);
  // What the customer pays = food − discount + delivery (the payment fee is the shop's cost).
  const amountDue = summary.productRevenue - (discountSatang ?? 0) + (deliverySatang ?? 0);
  const paymentAmount = paymentStatus === "paid" ? amountDue : paymentStatus === "unpaid" ? 0 : (paidSatang ?? 0);
  const partialError = paymentStatus === "partial" && (paidSatang === null || paidSatang <= 0 || paidSatang >= amountDue) ? "ยอดที่รับแล้วต้องมากกว่า 0 และน้อยกว่ายอดที่ต้องรับ" : null;

  const change = (id: string, amount: number) => setCart((current) => ({ ...current, [id]: Math.max(0, (current[id] || 0) + amount) }));
  const changePack = (id: string, delta: number) => setAdjust((current) => {
    const auto = autoPack.get(id) ?? 0;
    const next = Math.max(0, Math.max(0, auto + (current[id] ?? 0)) + delta);
    return { ...current, [id]: next - auto };
  });

  function chooseSlip(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    if (!SLIP_TYPES[file.type]) return setResult({ ok: false, text: "รองรับเฉพาะไฟล์ JPG, PNG หรือ WebP" });
    if (file.size > MAX_SLIP_BYTES) return setResult({ ok: false, text: "ไฟล์สลิปต้องไม่เกิน 10 MB" });
    setResult(null);
    setSlip(file);
  }

  function resetForm() {
    setCart({}); setAdjust({}); setFulfillment("pickup"); setDelivery(defaultDelivery); setDiscount("0"); setFee("0");
    setPaymentStatus("paid"); setPaidAmount(""); setCustomer(""); setSlip(null);
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
      const { data, error } = await supabase.rpc("create_sale", { payload: {
        items: selected.map((menu) => ({ menu_id: menu.id, quantity: cart[menu.id] })),
        packaging: packLines.filter((l) => l.quantity > 0).map((l) => ({ packaging_item_id: l.id, quantity: l.quantity })),
        fulfillment,
        pooled_ingredient_bps: pooledBps,
        discount_satang: discountSatang, delivery_charged_satang: deliverySatang, payment_fee_satang: feeSatang,
        payment_amount_satang: paymentAmount, payment_method: payment, payment_status: paymentStatus,
        customer_name: customer.trim() || null,
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

  let step = 1;
  return <div className="sale-composer">
    <section className="composer-main">
      <div className="step-head"><span>{step++}</span><div><h2>เลือกเมนู</h2><p>กด + ตามจำนวนที่สั่ง</p></div></div>
      <div className="menu-rows">
        {mainMenus.map((menu) => <MenuRow key={menu.id} menu={menu} count={cart[menu.id] ?? 0} onChange={change} />)}
        {!menus.length && <div className="empty-state">ยังไม่มีเมนูพร้อมขาย — <Link href="/menus" className="text-link">สร้างเมนูก่อน</Link></div>}
      </div>
      {addons.length > 0 && <>
        <h3 className="picker-subhead">ของเพิ่ม</h3>
        <div className="menu-rows is-addon">{addons.map((menu) => <MenuRow key={menu.id} menu={menu} count={cart[menu.id] ?? 0} onChange={change} />)}</div>
      </>}

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
      <div className="order-lines">{selected.map((menu) => <div key={menu.id}><span>{menu.name}<small>{cart[menu.id]} × {formatBaht(menu.price)}</small></span><strong>{formatBaht(menu.price * cart[menu.id])}</strong></div>)}</div>
      <div className="summary-row"><span>ยอดอาหาร</span><strong>{formatBaht(summary.productRevenue)}</strong></div>
      {fulfillment === "delivery" && <div className="summary-row"><span>ค่าส่ง</span><strong>+{formatBaht(deliverySatang ?? 0)}</strong></div>}
      {(discountSatang ?? 0) > 0 && <div className="summary-row"><span>ส่วนลด</span><strong>−{formatBaht(discountSatang!)}</strong></div>}
      <div className="summary-total"><span>ยอดที่ต้องรับ</span><strong>{formatBaht(Math.max(0, amountDue))}</strong></div>
      {paymentStatus !== "paid" && <div className="summary-row"><span>ค้างรับ</span><strong>{formatBaht(Math.max(0, amountDue - paymentAmount))}</strong></div>}
      <div className="summary-row muted-row"><span>ต้นทุนวัตถุดิบ (ประมาณ)</span><strong>{formatBaht(Math.max(0, summary.cogs - packagingCost))}</strong></div>
      {packaging.length > 0 && <div className="summary-row muted-row"><span>ต้นทุนบรรจุภัณฑ์</span><strong>{formatBaht(packagingCost)}</strong></div>}
      {(feeSatang ?? 0) > 0 && <div className="summary-row muted-row"><span>ค่าธรรมเนียม</span><strong>−{formatBaht(feeSatang!)}</strong></div>}
      <div className="profit-box"><span>กำไรขั้นต้น</span><strong>{formatBaht(summary.grossProfit)}</strong><small>{(summary.marginBasisPoints / 100).toFixed(1)}% · {boxes} กล่อง{fulfillment === "delivery" ? " · ส่ง" : ""}</small></div>
      {(summaryError || partialError) && <p className="form-error" role="alert">{summaryError ?? partialError}</p>}
      <button id="sale-save" className="primary-button save-sale" disabled={!summary.boxes || saving || !!summaryError || !!partialError} onClick={save}><Check size={18} /> {saving ? "กำลังบันทึก…" : "ยืนยันและบันทึก"}</button>
      <p className="atomic-note"><ShieldCheck size={15} /> รายการขาย บรรจุภัณฑ์ และการชำระเงินจะบันทึกพร้อมกัน</p>
      {result && <div className={result.ok ? "success-toast" : "error-toast"} role="status">{result.text}{result.ok && result.saleId && <> · <Link href="/sales" className="text-link">ดูประวัติ</Link></>}</div>}
    </aside>
  </div>;
}

/** One menu as a row: emoji, name, price and a − count + control (starts at 0). */
function MenuRow({ menu, count, onChange }: { menu: MenuOption; count: number; onChange: (id: string, delta: number) => void }) {
  return <div className={`menu-row ${count ? "selected" : ""}`}>
    <span className="menu-row-emoji" aria-hidden>{menu.emoji}</span>
    <span className="menu-row-name"><strong>{menu.name}</strong><small>{formatBaht(menu.price)}</small></span>
    <div className="menu-row-qty">
      <button type="button" onClick={() => onChange(menu.id, -1)} disabled={!count} aria-label={`ลด ${menu.name}`}><Minus size={16} /></button>
      <b>{count}</b>
      <button type="button" onClick={() => onChange(menu.id, 1)} aria-label={`เพิ่ม ${menu.name}`}><Plus size={16} /></button>
    </div>
  </div>;
}
