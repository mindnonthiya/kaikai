"use client";

import Link from "next/link";
import { useState } from "react";
import { MailCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { hasSupabaseEnv } from "@/lib/env";
import { authErrorMessage } from "@/lib/auth";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!hasSupabaseEnv) return setError("ยังไม่ได้เชื่อม Supabase");
    setLoading(true);
    const { error: resetError } = await createClient().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    setLoading(false);
    if (resetError) return setError(authErrorMessage(resetError));
    setSent(true);
  }

  if (sent) return <div className="login-card">
    <div className="auth-icon"><MailCheck size={28} /></div>
    <h2>ส่งลิงก์แล้ว</h2>
    <p>ถ้ามีบัญชีที่ใช้อีเมล <strong>{email}</strong> คุณจะได้รับลิงก์สำหรับตั้งรหัสผ่านใหม่ในไม่กี่นาที</p>
    <Link href="/login" className="secondary-button login-submit">กลับไปหน้าเข้าสู่ระบบ</Link>
  </div>;

  return <div className="login-card">
    <p className="eyebrow">กู้คืนบัญชี</p>
    <h2>ลืมรหัสผ่าน</h2>
    <p>กรอกอีเมลที่ใช้สมัคร เราจะส่งลิงก์ให้ตั้งรหัสผ่านใหม่</p>
    <form onSubmit={submit}>
      <label>อีเมล<input id="forgot-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button id="forgot-submit" className="primary-button login-submit" disabled={loading}>{loading ? "กำลังส่ง…" : "ส่งลิงก์ตั้งรหัสผ่านใหม่"}</button>
    </form>
    <small><Link href="/login" className="text-link">← กลับไปหน้าเข้าสู่ระบบ</Link></small>
  </div>;
}
