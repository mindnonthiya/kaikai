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

  return (
    <div className="app-shell">
      <aside className={`sidebar ${open ? "is-open" : ""}`}>
        <div className="sidebar-head"><Brand /><button className="icon-button mobile-only" onClick={() => setOpen(false)} aria-label="ปิดเมนู"><X /></button></div>
        <nav className="side-nav" aria-label="เมนูหลัก">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} onClick={() => setOpen(false)} className={active(href) ? "active" : ""}>
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
          <button className="icon-button mobile-only" onClick={() => setOpen(true)} aria-label="เปิดเมนู"><Menu /></button>
          <div className="mobile-only"><Brand compact /></div>
          <div className="topbar-spacer" />
          {demoMode && <span className="demo-pill">ยังไม่เชื่อมฐานข้อมูล</span>}
          <span className="topbar-shop">{shopName || displayName}</span>
          <Link href="/settings" className="avatar small" aria-label="ตั้งค่าบัญชี">{initial}</Link>
        </header>
        {demoMode && <div className="demo-banner">ยังไม่ได้เชื่อม Supabase — ตั้งค่า .env.local แล้วรีสตาร์ตเซิร์ฟเวอร์เพื่อบันทึกข้อมูลจริง</div>}
        <main className="page-content">{children}</main>
      </div>
      <nav className="bottom-nav" aria-label="เมนูมือถือ">
        {navItems.slice(0, 4).map(({ href, label, icon: Icon, accent }) => (
          <Link key={href} href={href} className={`${active(href) ? "active" : ""} ${accent ? "accent" : ""}`}>
            <Icon size={accent ? 25 : 21} /><span>{label === "เพิ่มยอดขาย" ? "เพิ่มขาย" : label}</span>
          </Link>
        ))}
        <button onClick={() => setOpen(true)}><Menu size={21} /><span>เพิ่มเติม</span></button>
      </nav>
    </div>
  );
}
