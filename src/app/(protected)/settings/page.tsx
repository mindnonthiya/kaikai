import { ShieldCheck } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { ActionForm } from "@/components/action-form";
import { LogoutButton } from "@/components/logout-button";
import { changePassword, saveProfile } from "@/app/actions/settings";
import { fetchProfile } from "@/lib/data/queries";
import { hasSupabaseEnv } from "@/lib/env";

export default async function SettingsPage() {
  const profile = await fetchProfile();
  return <>
    <PageTitle eyebrow="ระบบ" title="ตั้งค่า" description="ข้อมูลร้าน บัญชี และการเชื่อมต่อ" />
    <div className="settings-grid">
      <section className="panel settings-card">
        <h2>ข้อมูลร้าน</h2>
        <ActionForm action={saveProfile} submitLabel="บันทึกการเปลี่ยนแปลง" className="settings-form" resetOnSuccess={false}>
          <label>ชื่อร้าน<input id="settings-shop" name="shop_name" defaultValue={profile.shopName} maxLength={80} required /></label>
          <label>ชื่อของคุณ<input id="settings-name" name="display_name" defaultValue={profile.displayName} maxLength={80} required /></label>
          <label>เขตเวลา<input value="Asia/Bangkok (UTC+7)" readOnly /></label>
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
        <div className="connection-row"><span><i className="warn" />OCR อ่านสลิป</span><strong>ยังไม่เปิดใช้</strong></div>
        <p className="privacy-note"><ShieldCheck size={17} />ข้อมูลของแต่ละบัญชีแยกกันด้วย Row Level Security และสลิปเก็บใน Private Storage</p>
      </section>
    </div>
  </>;
}
