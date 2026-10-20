"use client";

import Link from "next/link";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { hasSupabaseEnv } from "@/lib/env";
import { authErrorMessage } from "@/lib/auth";

export function LoginForm({ next, notice }: { next: string; notice?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!hasSupabaseEnv) return setError("ยังไม่ได้เชื่อม Supabase — ตั้งค่า .env.local ก่อน");
    setLoading(true);
    const { error: signInError } = await createClient().auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (signInError) return setError(authErrorMessage(signInError));
    window.location.assign(next);
  }

  return <div className="login-card">
    <p className="eyebrow">สำหรับเจ้าของร้าน</p>
    <h2>เข้าสู่ระบบ kaikai</h2>
    <p>จัดการร้านต่อจากที่ค้างไว้</p>
    {!hasSupabaseEnv && <div className="login-demo">ยังไม่ได้เชื่อม Supabase — ตั้งค่า .env.local แล้วรีสตาร์ตเซิร์ฟเวอร์</div>}
    {notice && <p className="form-error" role="alert">{notice}</p>}
    <form onSubmit={submit}>
      <label>อีเมล<input id="login-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@example.com" required={hasSupabaseEnv} /></label>
      <label>
        <span className="label-row">รหัสผ่าน<Link href="/forgot-password">ลืมรหัสผ่าน?</Link></span>
        <input id="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="อย่างน้อย 8 ตัวอักษร" required={hasSupabaseEnv} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button id="login-submit" className="primary-button login-submit" disabled={loading || !hasSupabaseEnv}>{loading ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}</button>
    </form>
    <small>ยังไม่มีบัญชี? <Link href="/signup" className="text-link">สมัครใช้งานฟรี</Link></small>
  </div>;
}
