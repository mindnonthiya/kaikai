"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

export function LogoutButton() {
  const router = useRouter();
  async function logout() {
    if (hasSupabaseEnv) await createClient().auth.signOut();
    router.push("/login"); router.refresh();
  }
  return <button className="danger-button" onClick={logout}><LogOut size={17} /> ออกจากระบบ</button>;
}
