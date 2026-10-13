import { AppShell } from "@/components/app-shell";
import { hasSupabaseEnv } from "@/lib/env";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return <AppShell demoMode={!hasSupabaseEnv}>{children}</AppShell>;
}
