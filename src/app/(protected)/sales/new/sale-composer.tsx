"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, ImagePlus, Minus, Plus, ShieldCheck, X } from "lucide-react";
import { calculateSale, formatBaht, tryBahtToSatang } from "@/lib/money";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

type Cart = Record<string, number>;
type PaymentStatus = "paid" | "partial" | "unpaid";
export type MenuOption = { id: string; name: string; price: number; cost: number; emoji: string; category: string };

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

export function SaleComposer({ menus }: { menus: MenuOption[] }) {
  const router = useRouter();
  const [cart, setCart] = useState<Cart>(menus[0] ? { [menus[0].id]: 1 } : {});
  const [discount, setDiscount] = useState("0");
  const [delivery, setDelivery] = useState("0");
  const [fee, setFee] = useState("0");
  const [payment, setPayment] = useState("transfer");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("paid");
  const [paidAmount, setPaidAmount] = useState("");
  const [customer, setCustomer] = useState("");
  const [slip, setSlip] = useState<File | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string; saleId?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const discountSatang = tryBahtToSatang(discount);
  const deliverySatang = tryBahtToSatang(delivery);
  const feeSatang = tryBahtToSatang(fee);
  const paidSatang = tryBahtToSatang(paidAmount);
  const inputError = discountSatang === null ? "ส่วนลดไม่ถูกต้อง" : deliverySatang === null ? "ค่าส่งไม่ถูกต้อง" : feeSatang === null ? "ค่าธรรมเนียมไม่ถูกต้อง" : null;

  const selected = menus.filter((menu) => cart[menu.id]);
  const items = selected.map((menu) => ({ unitPrice: menu.price, unitCost: menu.cost, quantity: cart[menu.id] }));
  let summary = { productRevenue: 0, netRevenue: 0, cogs: 0, grossProfit: 0, boxes: 0, marginBasisPoints: 0 };
  let summaryError: string | null = inputError;
  if (items.length && !inputError) {
    try { summary = calculateSale({ items, discount: discountSatang!, deliveryCharged: deliverySatang!, paymentFee: feeSatang! }); }
    catch (error) { summaryError = error instanceof Error ? error.message : "คำนวณยอดไม่ได้"; }
  }
  // What the customer pays = product − discount + delivery (the payment fee is the shop's cost).
  const amountDue = summary.productRevenue - (discountSatang ?? 0) + (deliverySatang ?? 0);
  const paymentAmount = paymentStatus === "paid" ? amountDue : paymentStatus === "unpaid" ? 0 : (paidSatang ?? 0);
  const partialError = paymentStatus === "partial" && (paidSatang === null || paidSatang <= 0 || paidSatang >= amountDue) ? "ยอดที่รับแล้วต้องมากกว่า 0 และน้อยกว่ายอดที่ต้องรับ" : null;

  const change = (id: string, amount: number) => setCart((current) => ({ ...current, [id]: Math.max(0, (current[id] || 0) + amount) }));

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
    setCart({}); setDiscount("0"); setDelivery("0"); setFee("0"); setPaymentStatus("paid"); setPaidAmount(""); setCustomer(""); setSlip(null);
  }

  async function save() {
    setResult(null);
    if (summaryError || partialError) return setResult({ ok: false, text: summaryError ?? partialError! });
    if (!hasSupabaseEnv) return setResult({ ok: true, text: "ตัวอย่าง: ตรวจข้อมูลเรียบร้อย เชื่อม Supabase เพื่อบันทึกจริง" });
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
        discount_satang: discountSatang, delivery_charged_satang: deliverySatang, payment_fee_satang: feeSatang,
        payment_amount_satang: paymentAmount, payment_method: payment, payment_status: paymentStatus,
        customer_name: customer.trim() || null,
        ...(slipPayload ? { slip: slipPayload } : {}),
      } });
      if (error) {
        if (error.message.includes("slip_uploads_owner_id_file_hash_sha256_key")) throw new Error("สลิปนี้เคยแนบกับรายการอื่นแล้ว — ตรวจสอบว่าไม่ได้บันทึกซ้ำ");
        if (error.message.includes("menu unavailable")) throw new Error("มีเมนูที่ถูกปิดการขายหรือถูกลบไปแล้ว กรุณารีเฟรชหน้า");
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

  return <div className="sale-composer">
    <section className="composer-main">
      <div className="step-head"><span>1</span><div><h2>เลือกเมนู</h2><p>แตะเมนูเพื่อเพิ่มจำนวน</p></div></div>
      <div className="menu-picker">{menus.map((menu) => <article key={menu.id} className={cart[menu.id] ? "selected" : ""}><button className="menu-select" onClick={() => change(menu.id, 1)}><span>{menu.emoji}</span><strong>{menu.name}</strong><small>{formatBaht(menu.price)}</small></button>{cart[menu.id] > 0 && <div className="qty"><button onClick={() => change(menu.id, -1)} aria-label={`ลด ${menu.name}`}><Minus size={16} /></button><b>{cart[menu.id]}</b><button onClick={() => change(menu.id, 1)} aria-label={`เพิ่ม ${menu.name}`}><Plus size={16} /></button></div>}</article>)}{!menus.length && <div className="empty-state">ยังไม่มีเมนูพร้อมขาย — <Link href="/menus" className="text-link">สร้างเมนูก่อน</Link></div>}</div>
      <div className="step-head second"><span>2</span><div><h2>รายละเอียดการชำระ</h2><p>ยอดเพิ่มเติมและช่องทางรับเงิน</p></div></div>
      <div className="form-grid">
        <label>ช่องทางชำระ<select id="sale-payment-method" value={payment} onChange={(e) => setPayment(e.target.value)}><option value="transfer">เงินโอน</option><option value="cash">เงินสด</option><option value="other">อื่น ๆ</option></select></label>
        <label>ชื่อลูกค้า (ไม่บังคับ)<input id="sale-customer" value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={120} placeholder="เช่น คุณเมย์" /></label>
        <label>ส่วนลด (บาท)<input id="sale-discount" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} aria-invalid={discountSatang === null} /></label>
        <label>ค่าส่งที่เรียกเก็บ (บาท)<input id="sale-delivery" inputMode="decimal" value={delivery} onChange={(e) => setDelivery(e.target.value)} aria-invalid={deliverySatang === null} /></label>
        <label>ค่าธรรมเนียมที่ร้านจ่าย (บาท)<input id="sale-fee" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} aria-invalid={feeSatang === null} /></label>
        <label>สถานะการรับเงิน<select id="sale-payment-status" value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as PaymentStatus)}><option value="paid">ชำระครบแล้ว</option><option value="partial">ชำระบางส่วน</option><option value="unpaid">ยังไม่ชำระ</option></select></label>
        {paymentStatus === "partial" && <label>ยอดที่รับแล้ว (บาท)<input id="sale-paid-amount" inputMode="decimal" value={paidAmount} onChange={(e) => setPaidAmount(e.target.value)} placeholder={`น้อยกว่า ${formatBaht(amountDue, false)}`} aria-invalid={!!partialError} /></label>}
      </div>
      {payment === "transfer" && (slip
        ? <div className="slip-chosen"><ImagePlus size={18} /><span><strong>{slip.name}</strong><small>{(slip.size / 1024).toFixed(0)} KB · จะอัปโหลดเมื่อกดบันทึก</small></span><button type="button" className="icon-button" onClick={() => setSlip(null)} aria-label="เอาสลิปออก"><X size={18} /></button></div>
        : <label className="slip-drop"><input id="sale-slip" type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseSlip} /><ImagePlus /><strong>แนบสลิปการโอน (ไม่บังคับ)</strong><span>JPG, PNG หรือ WebP ไม่เกิน 10 MB</span><small>สลิปไม่ใช่หลักฐานยืนยันว่าเงินเข้าบัญชีจริง</small></label>)}
    </section>
    <aside className="order-summary"><h2>สรุปรายการ</h2>
      <div className="order-lines">{selected.map((menu) => <div key={menu.id}><span>{menu.name}<small>{cart[menu.id]} × {formatBaht(menu.price)}</small></span><strong>{formatBaht(menu.price * cart[menu.id])}</strong></div>)}</div>
      <div className="summary-row"><span>ยอดสินค้า</span><strong>{formatBaht(summary.productRevenue)}</strong></div>
      <div className="summary-row"><span>ต้นทุนสินค้า</span><strong>{formatBaht(summary.cogs)}</strong></div>
      <div className="summary-total"><span>ยอดที่ต้องรับ</span><strong>{formatBaht(Math.max(0, amountDue))}</strong></div>
      {paymentStatus !== "paid" && <div className="summary-row"><span>ค้างรับ</span><strong>{formatBaht(Math.max(0, amountDue - paymentAmount))}</strong></div>}
      <div className="profit-box"><span>กำไรขั้นต้น</span><strong>{formatBaht(summary.grossProfit)}</strong><small>{(summary.marginBasisPoints / 100).toFixed(1)}% · {summary.boxes} กล่อง</small></div>
      {(summaryError || partialError) && <p className="form-error" role="alert">{summaryError ?? partialError}</p>}
      <button id="sale-save" className="primary-button save-sale" disabled={!summary.boxes || saving || !!summaryError || !!partialError} onClick={save}><Check size={18} /> {saving ? "กำลังบันทึก…" : "ยืนยันและบันทึก"}</button>
      <p className="atomic-note"><ShieldCheck size={15} /> sale, items, payment และ snapshot จะบันทึกพร้อมกัน</p>
      {result && <div className={result.ok ? "success-toast" : "error-toast"} role="status">{result.text}{result.ok && result.saleId && <> · <Link href="/sales" className="text-link">ดูประวัติ</Link></>}</div>}
    </aside>
  </div>;
}
