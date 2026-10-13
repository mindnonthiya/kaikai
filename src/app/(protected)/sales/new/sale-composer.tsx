"use client";

import { useState } from "react";
import { Check, ImagePlus, Minus, Plus, ShieldCheck } from "lucide-react";
import { bahtToSatang, calculateSale, formatBaht } from "@/lib/money";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

type Cart = Record<string, number>;
export type MenuOption = { id: string; name: string; price: number; cost: number; emoji: string; category: string };

export function SaleComposer({ menus }: { menus: MenuOption[] }) {
  const [cart, setCart] = useState<Cart>(menus[0] ? { [menus[0].id]: 1 } : {});
  const [discount, setDiscount] = useState("0");
  const [delivery, setDelivery] = useState("0");
  const [fee, setFee] = useState("0");
  const [payment, setPayment] = useState("transfer");
  const [result, setResult] = useState("");
  const [saving, setSaving] = useState(false);
  const items = menus.filter((menu) => cart[menu.id]).map((menu) => ({ unitPrice: menu.price, unitCost: menu.cost, quantity: cart[menu.id] }));
  const summary = items.length ? calculateSale({ items, discount: bahtToSatang(discount || "0"), deliveryCharged: bahtToSatang(delivery || "0"), paymentFee: bahtToSatang(fee || "0") }) : { productRevenue: 0, netRevenue: 0, cogs: 0, grossProfit: 0, boxes: 0, marginBasisPoints: 0 };
  const change = (id: string, amount: number) => setCart((current) => ({ ...current, [id]: Math.max(0, (current[id] || 0) + amount) }));
  async function save() {
    setResult("");
    if (!hasSupabaseEnv) { setResult("ตัวอย่าง: ตรวจข้อมูลเรียบร้อย เชื่อม Supabase เพื่อบันทึกจริง"); return; }
    setSaving(true);
    const { data, error } = await createClient().rpc("create_sale", { payload: {
      items: menus.filter((menu) => cart[menu.id]).map((menu) => ({ menu_id: menu.id, quantity: cart[menu.id] })),
      discount_satang: bahtToSatang(discount || "0"), delivery_charged_satang: bahtToSatang(delivery || "0"), payment_fee_satang: bahtToSatang(fee || "0"),
      payment_amount_satang: summary.netRevenue, payment_method: payment, payment_status: "paid",
    } });
    setSaving(false);
    setResult(error ? `บันทึกไม่สำเร็จ: ${error.message}` : `บันทึกแล้ว · เลขอ้างอิง ${String((data as { sale_id?: string })?.sale_id ?? "")}`);
  }

  return <div className="sale-composer">
    <section className="composer-main">
      <div className="step-head"><span>1</span><div><h2>เลือกเมนู</h2><p>แตะเมนูเพื่อเพิ่มจำนวน</p></div></div>
      <div className="menu-picker">{menus.map((menu) => <article key={menu.id} className={cart[menu.id] ? "selected" : ""}><button className="menu-select" onClick={() => change(menu.id, 1)}><span>{menu.emoji}</span><strong>{menu.name}</strong><small>{formatBaht(menu.price)}</small></button>{cart[menu.id] > 0 && <div className="qty"><button onClick={() => change(menu.id, -1)} aria-label={`ลด ${menu.name}`}><Minus size={16} /></button><b>{cart[menu.id]}</b><button onClick={() => change(menu.id, 1)} aria-label={`เพิ่ม ${menu.name}`}><Plus size={16} /></button></div>}</article>)}{!menus.length && <div className="empty-state">ยังไม่มีเมนูพร้อมขาย กรุณาสร้างเมนูก่อนบันทึกยอดขาย</div>}</div>
      <div className="step-head second"><span>2</span><div><h2>รายละเอียดการชำระ</h2><p>ยอดเพิ่มเติมและช่องทางรับเงิน</p></div></div>
      <div className="form-grid"><label>ช่องทางชำระ<select value={payment} onChange={(e) => setPayment(e.target.value)}><option value="transfer">เงินโอน</option><option value="cash">เงินสด</option><option value="other">อื่น ๆ</option></select></label><label>ชื่อลูกค้า (ไม่บังคับ)<input placeholder="เช่น คุณเมย์" /></label><label>ส่วนลด (บาท)<input inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} /></label><label>ค่าส่งที่เรียกเก็บ (บาท)<input inputMode="decimal" value={delivery} onChange={(e) => setDelivery(e.target.value)} /></label><label>ค่าธรรมเนียม (บาท)<input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></label><label>สถานะการรับเงิน<select><option>ชำระครบแล้ว</option><option>ชำระบางส่วน</option><option>ยังไม่ชำระ</option></select></label></div>
      {payment === "transfer" && <label className="slip-drop"><input type="file" accept="image/jpeg,image/png,image/webp" /><ImagePlus /><strong>แนบสลิปการโอน</strong><span>JPG, PNG หรือ WebP ไม่เกิน 10 MB</span><small>OCR ไม่ใช่หลักฐานยืนยันว่าเงินเข้าบัญชีจริง</small></label>}
    </section>
    <aside className="order-summary"><h2>สรุปรายการ</h2><div className="order-lines">{menus.filter((m) => cart[m.id]).map((menu) => <div key={menu.id}><span>{menu.name}<small>{cart[menu.id]} × {formatBaht(menu.price)}</small></span><strong>{formatBaht(menu.price * cart[menu.id])}</strong></div>)}</div><div className="summary-row"><span>ยอดสินค้า</span><strong>{formatBaht(summary.productRevenue)}</strong></div><div className="summary-row"><span>ต้นทุนสินค้า</span><strong>{formatBaht(summary.cogs)}</strong></div><div className="summary-total"><span>ยอดที่ต้องรับ</span><strong>{formatBaht(summary.netRevenue)}</strong></div><div className="profit-box"><span>กำไรขั้นต้น</span><strong>{formatBaht(summary.grossProfit)}</strong><small>{(summary.marginBasisPoints / 100).toFixed(1)}% · {summary.boxes} กล่อง</small></div><button className="primary-button save-sale" disabled={!summary.boxes || saving} onClick={save}><Check size={18} /> {saving ? "กำลังบันทึก…" : "ยืนยันและบันทึก"}</button><p className="atomic-note"><ShieldCheck size={15} /> sale, items, payment และ snapshot จะบันทึกพร้อมกัน</p>{result && <div className={result.startsWith("บันทึกไม่สำเร็จ") ? "error-toast" : "success-toast"} role="status">{result}</div>}</aside>
  </div>;
}
