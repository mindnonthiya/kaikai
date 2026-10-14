"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MailCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { hasSupabaseEnv } from "@/lib/env";
import { authErrorMessage } from "@/lib/auth";

export function SignupForm() {
  const router = useRouter();
  const [form, setForm] = useState({ shopName: "", displayName: "", email: "", password: "", confirm: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!hasSupabaseEnv) return setError("ยังไม่ได้เชื่อม Supabase จึงยังสมัครสมาชิกไม่ได้");
    if (form.password.length < 8) return setError("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
    if (form.password !== form.confirm) return setError("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
    const email = form.email.trim();
    const shopName = form.shopName.trim();
    if (!shopName) return setError("กรุณาระบุชื่อร้านของคุณ");
    // Use shopName as the account's display name
    const displayName = form.displayName.trim() || shopName;
    setLoading(true);
    const { data, error: signUpError } = await createClient().auth.signUp({
      email,
      password: form.password,
      options: {
        // Saved to auth.users metadata; the database trigger copies them into public.profiles.
        data: { shop_name: shopName, display_name: displayName },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/dashboard`,
      },
    });
    setLoading(false);
    if (signUpError) return setError(authErrorMessage(signUpError));
    // Supabase returns a user with no identities when the email is already registered (to avoid leaking accounts).
    if (data.user && data.user.identities?.length === 0) return setError(authErrorMessage({ code: "user_already_exists", message: "" }));
    if (data.session) { router.push("/dashboard"); router.refresh(); return; }
    setSentTo(email);
  }

  if (sentTo) return <div className="login-card">
    <div className="auth-icon"><MailCheck size={28} /></div>
    <h2>ตรวจสอบอีเมลของคุณ</h2>
    <p>เราส่งลิงก์ยืนยันไปที่ <strong>{sentTo}</strong> แล้ว กดลิงก์ในอีเมลเพื่อเปิดใช้งานบัญชี</p>
    <p className="muted-note">ไม่เห็นอีเมล? ลองดูในโฟลเดอร์ Spam หรือ Promotions</p>
    <Link href="/login" className="secondary-button login-submit">กลับไปหน้าเข้าสู่ระบบ</Link>
  </div>;

  return <div className="login-card">
    <p className="eyebrow">เริ่มต้นใช้งานฟรี</p>
    <h2>สร้างบัญชีร้านของคุณ</h2>
    <p>ระบุชื่อร้านเพื่อใช้เป็นชื่อบัญชี ข้อมูลของแต่ละร้านแยกจากกัน</p>
    <form onSubmit={submit}>
      <label>
        ชื่อร้าน (ใช้เป็นชื่อบัญชีร้าน)
        <input id="signup-shop" value={form.shopName} onChange={set("shopName")} placeholder="เช่น ข้าวมันไก่ป้าแดง" maxLength={80} required />
      </label>
      <label>
        ชื่อเจ้าของร้าน / ผู้ติดต่อ <span className="muted-hint">(ไม่บังคับ — หากเว้นว่างจะใช้ชื่อร้าน)</span>
        <input id="signup-name" value={form.displayName} onChange={set("displayName")} placeholder={form.shopName.trim() || "เช่น ป้าแดง"} maxLength={80} autoComplete="name" />
      </label>
      <label>อีเมล<input id="signup-email" type="email" value={form.email} onChange={set("email")} placeholder="you@example.com" autoComplete="email" required /></label>
      <label>รหัสผ่าน<input id="signup-password" type="password" value={form.password} onChange={set("password")} placeholder="อย่างน้อย 8 ตัวอักษร" autoComplete="new-password" minLength={8} required /></label>
      <label>ยืนยันรหัสผ่าน<input id="signup-confirm" type="password" value={form.confirm} onChange={set("confirm")} autoComplete="new-password" minLength={8} required /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button id="signup-submit" className="primary-button login-submit" disabled={loading}>{loading ? "กำลังสร้างบัญชี…" : "สมัครใช้งาน"}</button>
    </form>
    <small>มีบัญชีแล้ว? <Link href="/login" className="text-link">เข้าสู่ระบบ</Link></small>
  </div>;
}
