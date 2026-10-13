"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { hasSupabaseEnv } from "@/lib/env";
import { authErrorMessage } from "@/lib/auth";

export function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!hasSupabaseEnv) return setError("ยังไม่ได้เชื่อม Supabase");
    if (password.length < 8) return setError("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
    if (password !== confirm) return setError("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
    setLoading(true);
    const { error: updateError } = await createClient().auth.updateUser({ password });
    setLoading(false);
    if (updateError) return setError(authErrorMessage(updateError));
    router.push("/dashboard"); router.refresh();
  }

  return <div className="login-card">
    <p className="eyebrow">กู้คืนบัญชี</p>
    <h2>ตั้งรหัสผ่านใหม่</h2>
    <p>ตั้งรหัสผ่านใหม่แล้วเข้าใช้งานได้ทันที</p>
    <form onSubmit={submit}>
      <label>รหัสผ่านใหม่<input id="reset-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required /></label>
      <label>ยืนยันรหัสผ่านใหม่<input id="reset-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} required /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button id="reset-submit" className="primary-button login-submit" disabled={loading}>{loading ? "กำลังบันทึก…" : "บันทึกรหัสผ่านใหม่"}</button>
    </form>
  </div>;
}
