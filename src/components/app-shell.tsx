"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Brand } from "./brand";
import { navItems } from "./icons";

export function AppShell({ children, demoMode, shopName, displayName }: { children: React.ReactNode; demoMode: boolean; shopName: string; displayName: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => href === "/dashboard" || href === "/sales" ? pathname === href : pathname.startsWith(href);
  const initial = Array.from((displayName || shopName || "ก").trim())[0] ?? "ก";
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
        </nav>
        <div className="sidebar-footer">
          <div className="avatar">{initial}</div>
          <div>
            <strong>{displayName || shopName}</strong>
            <span>{demoMode ? "ยังไม่เชื่อมฐานข้อมูล" : (displayName !== shopName && shopName ? shopName : "ร้านค้าของคุณ")}</span>
          </div>
        </div>
      </aside>
      {open && <button className="scrim" onClick={() => setOpen(false)} aria-label="ปิดเมนู" />}
      <div className="main-column">
        <header className="topbar">
          <div className="mobile-only"><Link href="/dashboard" aria-label="หน้าหลัก"><Brand compact /></Link></div>
          <div className="topbar-spacer" />
          {demoMode && <span className="demo-pill">ยังไม่เชื่อมฐานข้อมูล</span>}
          <span className="topbar-shop">{shopName || displayName}</span>
          <Link href="/settings" className="avatar small desktop-only" aria-label="ตั้งค่าบัญชี">{initial}</Link>
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
          <span className="nav-avatar">{initial}</span>
          <span>โปรไฟล์</span>
        </Link>
      </nav>
    </div>
  );
}
