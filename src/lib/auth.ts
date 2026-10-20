/**
 * Only allow redirects to a path on this site (blocks "//evil.com" and "https://..." open redirects).
 */
export function safeNextPath(value: string | string[] | null | undefined, fallback = "/dashboard") {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (raw === "/") return fallback;
  return raw;
}

/** Maps Supabase Auth error codes/messages to Thai. */
export function authErrorMessage(error: { code?: string; message: string }) {
  const code = error.code ?? "";
  const message = error.message.toLowerCase();
  if (code === "invalid_credentials" || message.includes("invalid login credentials")) return "อีเมลหรือรหัสผ่านไม่ถูกต้อง";
  if (code === "email_not_confirmed" || message.includes("email not confirmed")) return "ยังไม่ได้ยืนยันอีเมล กรุณากดลิงก์ยืนยันในอีเมลของคุณก่อน";
  if (code === "user_already_exists" || message.includes("already registered")) return "อีเมลนี้มีบัญชีอยู่แล้ว — ลองเข้าสู่ระบบ หรือกด “ลืมรหัสผ่าน”";
  if (code === "weak_password" || message.includes("password should")) return "รหัสผ่านง่ายเกินไป ต้องมีอย่างน้อย 8 ตัวอักษร";
  if (code === "signup_disabled" || message.includes("signups not allowed")) return "ระบบปิดรับสมัครสมาชิกใหม่อยู่";
  if (code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || message.includes("rate limit")) return "ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่";
  if (code === "same_password") return "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสเดิม";
  if (code === "email_address_invalid" || message.includes("invalid email")) return "รูปแบบอีเมลไม่ถูกต้อง";
  return `เกิดข้อผิดพลาด: ${error.message}`;
}
