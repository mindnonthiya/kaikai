import { ShieldCheck } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { ActionForm } from "@/components/action-form";
import { LogoutButton } from "@/components/logout-button";
import { PresetManager } from "@/components/preset-manager";
import { ProfileAvatarField } from "@/components/profile-avatar-field";
import { changePassword, saveProfile, saveSaleSettings, syncHistoricalSalesCosts } from "@/app/actions/settings";
import { POOLED_MIN_DAYS, formatPercentBps } from "@/lib/analytics";
import { fetchMenus, fetchPooledRate, fetchPricePresets, fetchProfile, fetchSaleSettings } from "@/lib/data/queries";
import { hasSupabaseEnv } from "@/lib/env";
import { formatBaht, satangToBahtInput } from "@/lib/money";
import { getOcrProvider } from "@/lib/ocr/types";
import { DAY_START_HOUR_OPTIONS, DEFAULT_DAY_START_HOUR } from "@/lib/time";

export default async function SettingsPage() {
  const [profile, saleSettings, menus, presets] = await Promise.all([
    fetchProfile(),
    fetchSaleSettings(),
    fetchMenus(),
    fetchPricePresets(),
  ]);
  const pooled = await fetchPooledRate(saleSettings);
  const ocrProvider = getOcrProvider();

  return <>
    <PageTitle eyebrow="ระบบ" title="ตั้งค่า" description="ข้อมูลร้าน บัญชี และการเชื่อมต่อ" />
    <div className="settings-grid">
      <section className="panel settings-card">
        <h2>ข้อมูลร้านและบัญชี</h2>
        <ActionForm action={saveProfile} submitLabel="บันทึกการเปลี่ยนแปลง" className="settings-form" resetOnSuccess={false}>
          <ProfileAvatarField
            currentAvatar={profile.avatarUrl}
            initialShopName={profile.shopName}
            initialDisplayName={profile.displayName === profile.shopName ? "" : profile.displayName}
          />
          <label>เขตเวลา<input value="Asia/Bangkok (UTC+7)" readOnly /></label>
        </ActionForm>
      </section>

      {/* Preset Manager: สูตรเปิดบิลด่วนตามยอดเงิน */}
      <PresetManager
        initialPresets={presets}
        menus={menus.filter((m) => m.isAvailable)}
        defaultDeliveryFee={saleSettings.defaultDeliveryFee}
        deliveryFeeOptions={saleSettings.deliveryFeeOptions}
      />

      <section className="panel settings-card">
        <h2>การขายและการแสดงผล</h2>
        <ActionForm action={saveSaleSettings} submitLabel="บันทึก" className="settings-form" resetOnSuccess={false}>
          <label>ค่าส่งเริ่มต้น (บาท)<input id="settings-delivery-fee" name="default_delivery_fee" inputMode="decimal" defaultValue={satangToBahtInput(saleSettings.defaultDeliveryFee)} required /></label>
          <p className="field-hint">ใส่ให้อัตโนมัติเมื่อเลือก “ส่ง” ตอนเปิดบิล แก้ได้ทุกออเดอร์</p>
          <label>ตัวเลือกค่าส่งด่วน (บาท, คั่นด้วยลูกน้ำ ,)<input id="settings-delivery-fee-options" name="delivery_fee_options" defaultValue={(saleSettings.deliveryFeeOptions ?? [1500, 2000]).map((s) => satangToBahtInput(s).replace(/\.00$/, "")).join(", ")} placeholder="เช่น 15, 20" /></label>
          <p className="field-hint">แสดงเป็นปุ่มกดลัดให้สลับเรทค่าส่งได้ทันทีตอนเปิดบิลและนำเข้าสลิป (เช่น 15, 20)</p>
          <label>วัตถุดิบอื่นเริ่มต้น (% ของราคาขาย)<input id="settings-initial-pooled" name="initial_pooled_percent" inputMode="decimal" defaultValue={String(saleSettings.initialPooledBps / 100)} required /></label>
          <p className="field-hint">ข้าว พริก กระเทียม ผักชี มะนาว ซอส — ใช้ค่านี้จนกว่าจะมียอดซื้อจริง {POOLED_MIN_DAYS} วัน แล้วระบบคำนวณเอง</p>
          <div className="connection-row"><span>ตอนนี้ใช้</span><strong>{formatPercentBps(pooled.bps)} · {pooled.source === "actual" ? `จากยอดซื้อ ${formatBaht(pooled.pooledPurchases)} ÷ ยอดขาย ${formatBaht(pooled.foodRevenue)} (${pooled.historyDays} วัน)` : `ค่าเริ่มต้น${pooled.historyDays ? ` · มีข้อมูล ${pooled.historyDays}/${POOLED_MIN_DAYS} วัน` : ""}`}</strong></div>
          <label>เวลาเริ่มวันใหม่ (ตัดรอบรายวัน)
            <select id="settings-day-start-hour" name="day_start_hour" defaultValue={String(saleSettings.dayStartHour ?? DEFAULT_DAY_START_HOUR)}>
              {DAY_START_HOUR_OPTIONS.map((opt) => (
                <option key={opt.hour} value={opt.hour}>{opt.label}</option>
              ))}
            </select>
          </label>
          <p className="field-hint">ค่าเริ่มต้นคือ 00:00 น. (เที่ยงคืน) หากร้านเปิดดึกหรือปิดเช้ามืด เช่น เลือก 06:00 น. ออเดอร์ก่อน 6 โมงเช้าจะถูกนับรวมเป็นยอดของวันก่อนหน้า</p>
          <label className="checkbox-toggle-wrap">
            <input type="checkbox" name="show_menu_images" defaultChecked={saleSettings.showMenuImages ?? true} />
            <div>
              <strong>แสดงรูปภาพเมนูอาหารในระบบ</strong>
              <small className="muted-hint" style={{ display: "block", marginTop: "3px" }}>
                เปิดเพื่อแสดงรูปภาพเมนู หรือปิดเพื่อซ่อนรูปภาพและแสดงเฉพาะชื่อเมนูแบบกะทัดรัด (โหลดเร็วขึ้นและประหยัดเน็ต)
              </small>
            </div>
          </label>
        </ActionForm>
      </section>

      <section className="panel settings-card">
        <h2>ออเดอร์และต้นทุนย้อนหลัง</h2>
        <p className="field-hint">หากคุณมีออเดอร์ในอดีตที่เคยบันทึกไว้ก่อนผูกสูตรต้นทุน หรือเพิ่งเพิ่มบรรจุภัณฑ์และส่วนผสมในสูตรอาหาร สามารถกดปุ่มนี้เพื่อให้ระบบนำสูตรปัจจุบันไปคำนวณต้นทุนและกำไรย้อนหลังให้อัตโนมัติ</p>
        <ActionForm
          action={syncHistoricalSalesCosts}
          submitLabel="คำนวณต้นทุนออเดอร์เก่าทั้งหมดใหม่"
          pendingLabel="กำลังคำนวณต้นทุนย้อนหลัง…"
          className="settings-form"
          resetOnSuccess={false}
        >
          <input type="hidden" name="force_all" value="true" />
          <div className="connection-row"><span>ต้นทุนออเดอร์เก่า</span><strong>อัปเดตตามสูตรปัจจุบัน</strong></div>
        </ActionForm>
      </section>

      <section className="panel settings-card">
        <h2>บัญชี</h2>
        <div className="connection-row"><span>อีเมล</span><strong>{profile.email ?? "—"}</strong></div>
        <ActionForm action={changePassword} submitLabel="เปลี่ยนรหัสผ่าน" className="settings-form">
          <label>รหัสผ่านใหม่<input id="settings-password" type="password" name="password" autoComplete="new-password" minLength={8} required /></label>
          <label>ยืนยันรหัสผ่านใหม่<input id="settings-confirm" type="password" name="confirm" autoComplete="new-password" minLength={8} required /></label>
        </ActionForm>
        <LogoutButton />
      </section>

      <section className="panel settings-card">
        <h2>สถานะระบบ</h2>
        <div className="connection-row"><span><i className={hasSupabaseEnv ? "ok" : "warn"} />Supabase</span><strong>{hasSupabaseEnv ? "เชื่อมต่อแล้ว" : "ยังไม่เชื่อมต่อ"}</strong></div>
        <div className="connection-row">
          <span><i className={ocrProvider ? "ok" : "warn"} />OCR อ่านสลิป</span>
          <strong>{ocrProvider ? `เปิดใช้แล้ว (${ocrProvider.name})` : "ยังไม่เปิดใช้ (กรอก API Key ใน .env)"}</strong>
        </div>
        <p className="privacy-note"><ShieldCheck size={17} />ข้อมูลของแต่ละบัญชีแยกกันด้วย Row Level Security และสลิปเก็บใน Private Storage</p>
      </section>
    </div>
  </>;
}
