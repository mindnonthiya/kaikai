import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "ตั้งรหัสผ่านใหม่ — kaikai" };

// Reached from the email link via /auth/callback, which signs the user in first.
// Middleware sends visitors without a session to /login.
export default function ResetPasswordPage() {
  return <AuthShell><ResetPasswordForm /></AuthShell>;
}
