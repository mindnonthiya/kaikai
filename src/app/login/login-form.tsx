"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { hasSupabaseEnv } from "@/lib/env";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!hasSupabaseEnv) { router.push("/dashboard"); return; }
    setLoading(true);
    const { error: signInError } = await createClient().auth.signInWithPassword({ email, password });
    setLoading(false);
    if (signInError) return setError("อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    router.push("/dashboard"); router.refresh();
  }

  return <div className="login-card"><p className="eyebrow">สำหรับเจ้าของร้าน</p><h2>เข้าสู่ระบบ kaikai</h2><p>จัดการร้านต่อจากที่ค้างไว้</p>{!hasSupabaseEnv && <div className="login-demo">ยังไม่ได้เชื่อม Supabase — กดเข้าสู่ระบบเพื่อชมข้อมูลตัวอย่าง</div>}<form onSubmit={submit}><label>อีเมล<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@example.com" required={hasSupabaseEnv} /></label><label>รหัสผ่าน<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="อย่างน้อย 8 ตัวอักษร" required={hasSupabaseEnv} /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button login-submit" disabled={loading}>{loading ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}</button></form><small>บัญชีเจ้าของร้านสร้างผ่าน Supabase Dashboard เท่านั้น ไม่มีการสมัครสมาชิกสาธารณะ</small></div>;
}
