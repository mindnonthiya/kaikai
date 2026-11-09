"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Brand } from "./brand";
import { navItems } from "./icons";
import { AVATAR_REMOVED_KEY, AVATAR_STORAGE_KEY, AVATAR_UPDATED_EVENT } from "./profile-avatar-field";
import { PwaDrawerInstallButton } from "./pwa-install";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";

export function AppShell({
  children,
  demoMode,
  shopName,
  displayName,
  avatarUrl,
}: {
  children: React.ReactNode;
  demoMode: boolean;
  shopName: string;
  displayName: string;
  avatarUrl?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [liveAvatarUrl, setLiveAvatarUrl] = useState<string | null>(avatarUrl ?? null);
  const [avatarBroken, setAvatarBroken] = useState(false);

  useEffect(() => {
    setAvatarBroken(false);
    if (avatarUrl) {
      setLiveAvatarUrl(avatarUrl);
      try {
        window.localStorage.setItem(AVATAR_STORAGE_KEY, avatarUrl);
        window.localStorage.removeItem(AVATAR_REMOVED_KEY);
      } catch {
        // Ignore
      }
    } else {
      try {
        const wasRemoved = window.localStorage.getItem(AVATAR_REMOVED_KEY) === "true";
        const cached = window.localStorage.getItem(AVATAR_STORAGE_KEY);
        setLiveAvatarUrl(!wasRemoved && cached ? cached : null);
      } catch {
        setLiveAvatarUrl(null);
      }
    }
  }, [avatarUrl]);

  useEffect(() => {
    function onAvatarUpdated(e: Event) {
      const detail = (e as CustomEvent<{ avatarUrl: string | null }>).detail;
      setAvatarBroken(false);
      setLiveAvatarUrl(detail?.avatarUrl ?? null);
    }
    window.addEventListener(AVATAR_UPDATED_EVENT, onAvatarUpdated);
    return () => window.removeEventListener(AVATAR_UPDATED_EVENT, onAvatarUpdated);
  }, []);

  async function handleLogout() {
    if (!window.confirm("คุณต้องการออกจากระบบใช่หรือไม่?")) return;
    setLoggingOut(true);
    setOpen(false);
    try {
      if (hasSupabaseEnv) {
        await createClient().auth.signOut();
      }
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  const active = (href: string) => href === "/dashboard" || href === "/sales" ? pathname === href : pathname.startsWith(href);
  const initial = Array.from((displayName || shopName || "ก").trim())[0] ?? "ก";
  const showAvatar = Boolean(liveAvatarUrl && !avatarBroken);
  const itemByHref = new Map(navItems.map((item) => [item.href, item]));
  const bottomNavItems = [
    itemByHref.get("/dashboard")!,
    itemByHref.get("/sales")!,
    { ...itemByHref.get("/sales/new")!, label: "เปิดบิล" },
    { ...itemByHref.get("/menus")!, label: "เมนู" },
  ].filter(Boolean);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${open ? "is-open" : ""}`}>
        <div className="sidebar-head"><Brand /><button className="icon-button mobile-only" onClick={() => setOpen(false)} aria-label="ปิดเมนู"><X /></button></div>
        <div className="mobile-drawer-label mobile-only">เมนูเพิ่มเติม</div>
        <nav className="side-nav" aria-label="เมนูหลัก">
          {navItems.map(({ href, label, icon: Icon, inBottomBar }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className={`${active(href) ? "active" : ""} ${inBottomBar ? "hide-in-mobile-drawer" : ""}`}
            >
              <Icon size={20} strokeWidth={2} /><span>{label}</span>
            </Link>
          ))}
          <PwaDrawerInstallButton onNavigate={() => setOpen(false)} />
          <button
            type="button"
            className="side-nav-logout"
            onClick={handleLogout}
            disabled={loggingOut}
            aria-label="ออกจากระบบ"
          >
            <LogOut size={20} strokeWidth={2} />
            <span>{loggingOut ? "กำลังออกจากระบบ…" : "ออกจากระบบ"}</span>
          </button>
        </nav>
        <div className="sidebar-footer">
          <div className="avatar">
            {showAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={liveAvatarUrl!} alt="" className="avatar-img" onError={() => setAvatarBroken(true)} />
            ) : (
              initial
            )}
          </div>
          <div>
            <strong>{displayName || shopName}</strong>
            <span>{demoMode ? "ยังไม่เชื่อมฐานข้อมูล" : (displayName !== shopName && shopName ? shopName : "ร้านค้าของคุณ")}</span>
          </div>
        </div>
      </aside>
      {open && <button className="scrim" onClick={() => setOpen(false)} aria-label="ปิดเมนู" />}
      <div className="main-column">
        <header className="topbar">
          <div className="mobile-only topbar-mobile-logo"><Link href="/dashboard" aria-label="หน้าหลัก"><Brand compact /></Link></div>
          <div className="topbar-spacer desktop-only" />
          {demoMode && <span className="demo-pill desktop-only">ยังไม่เชื่อมฐานข้อมูล</span>}
          <span className="topbar-shop">{shopName || displayName || "kaikai"}</span>
          <Link href="/settings" className="avatar small desktop-only" aria-label="ตั้งค่าบัญชี">
            {showAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={liveAvatarUrl!} alt="" className="avatar-img" onError={() => setAvatarBroken(true)} />
            ) : (
              initial
            )}
          </Link>
          <button type="button" className="topbar-menu-btn mobile-only" onClick={() => setOpen(true)} aria-label="เปิดเมนู">
            <Menu size={20} />
          </button>
        </header>
        {demoMode && <div className="demo-banner">ยังไม่ได้เชื่อม Supabase — ตั้งค่า .env.local แล้วรีสตาร์ตเซิร์ฟเวอร์เพื่อบันทึกข้อมูลจริง</div>}
        <main className="page-content">{children}</main>
      </div>
      <nav className="bottom-nav" aria-label="เมนูมือถือ">
        {bottomNavItems.map(({ href, label, icon: Icon, accent }) => (
          <Link key={href} href={href} className={`${active(href) ? "active" : ""} ${accent ? "accent" : ""}`}>
            <Icon size={accent ? 25 : 21} /><span>{label}</span>
          </Link>
        ))}
        <Link href="/settings" className={`nav-profile-tab ${active("/settings") ? "active" : ""}`} aria-label="โปรไฟล์">
          <span className="nav-avatar">
            {showAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={liveAvatarUrl!} alt="" className="avatar-img" onError={() => setAvatarBroken(true)} />
            ) : (
              initial
            )}
          </span>
          <span>โปรไฟล์</span>
        </Link>
      </nav>
    </div>
  );
}
