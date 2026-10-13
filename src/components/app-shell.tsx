"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Menu, X } from "lucide-react";
import { useState } from "react";
import { Brand } from "./brand";
import { navItems } from "./icons";

export function AppShell({ children, demoMode }: { children: React.ReactNode; demoMode: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => href === "/dashboard" ? pathname === href : pathname.startsWith(href);

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
        <div className="sidebar-footer"><div className="avatar">ก</div><div><strong>เจ้าของร้าน</strong><span>{demoMode ? "โหมดตัวอย่าง" : "เชื่อมต่อ Supabase"}</span></div></div>
      </aside>
      {open && <button className="scrim" onClick={() => setOpen(false)} aria-label="ปิดเมนู" />}
      <div className="main-column">
        <header className="topbar">
          <button className="icon-button mobile-only" onClick={() => setOpen(true)} aria-label="เปิดเมนู"><Menu /></button>
          <div className="mobile-only"><Brand compact /></div>
          <div className="topbar-spacer" />
          {demoMode && <span className="demo-pill">ข้อมูลตัวอย่าง</span>}
          <button className="icon-button" aria-label="การแจ้งเตือน"><Bell size={20} /></button>
          <div className="avatar small">ก</div>
        </header>
        {demoMode && <div className="demo-banner">กำลังแสดงข้อมูลตัวอย่าง — เชื่อมต่อ Supabase เพื่อบันทึกข้อมูลจริง</div>}
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
