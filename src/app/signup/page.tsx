import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";
import { SignupForm } from "./signup-form";

export const metadata: Metadata = { title: "สมัครใช้งาน — kaikai", description: "สร้างบัญชีร้านของคุณบน kaikai เพื่อติดตามยอดขาย ต้นทุน และกำไร" };

export default function SignupPage() {
  return <AuthShell><SignupForm /></AuthShell>;
}
