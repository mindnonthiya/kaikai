import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { safeNextPath } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "เข้าสู่ระบบ — kaikai" };

const LINK_ERRORS: Record<string, string> = {
  link: "ลิงก์ยืนยันหมดอายุหรือถูกใช้ไปแล้ว กรุณาขอลิงก์ใหม่",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; registered?: string }> }) {
  const params = await searchParams;
  return <AuthShell>
    <LoginForm next={safeNextPath(params.next)} notice={params.error ? LINK_ERRORS[params.error] ?? LINK_ERRORS.link : undefined} />
  </AuthShell>;
}
