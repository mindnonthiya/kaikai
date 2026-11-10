"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, Check, ChevronDown, Copy, Link2, LogOut, Menu, Plus, Settings, Unlink, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { createShopAction, switchShopAction } from "@/app/actions/settings";
import { Brand } from "./brand";
import { navItems } from "./icons";
import {
  AVATAR_UPDATED_EVENT,
  getAvatarRemovedKey,
  getAvatarStorageKey,
} from "./profile-avatar-field";
import { PwaDrawerInstallButton } from "./pwa-install";
import { DEFAULT_UNIT_LABEL, UNIT_LABEL_OPTIONS } from "@/lib/data/types";
import { hasSupabaseEnv } from "@/lib/env";
import { DEFAULT_SHOP_ID, resolveInventoryShopId, type ShopSummary } from "@/lib/shop-scope";
import { createClient } from "@/lib/supabase/client";

export function AppShell({
  children,
  demoMode,
  shopName,
  displayName,
  avatarUrl,
  activeShopId = DEFAULT_SHOP_ID,
  shops = [],
}: {
  children: React.ReactNode;
  demoMode: boolean;
  shopName: string;
  displayName: string;
  avatarUrl?: string | null;
  activeShopId?: string;
  shops?: ShopSummary[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [liveAvatarUrl, setLiveAvatarUrl] = useState<string | null>(avatarUrl ?? null);
  const [avatarBroken, setAvatarBroken] = useState(false);

  // Instagram-style Account/Shop Switcher Sheet state
  const [igSheetOpen, setIgSheetOpen] = useState(false);
  const [igSheetMode, setIgSheetMode] = useState<"list" | "create">("list");
  const [switchingShopId, setSwitchingShopId] = useState<string | null>(null);
  const [newShopName, setNewShopName] = useState("");
  const [newUnitLabel, setNewUnitLabel] = useState("กล่อง");
  const [shareMode, setShareMode] = useState<"shared" | "isolated">("shared");
  const [shareTargetShopId, setShareTargetShopId] = useState<string>(DEFAULT_SHOP_ID);
  const [copyIngredients, setCopyIngredients] = useState(true);
  const [copyMenus, setCopyMenus] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Long-press & double-tap detection for bottom-right profile tab (Instagram UX)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const lastTapTimeRef = useRef<number>(0);

  useEffect(() => {
    setAvatarBroken(false);
    const storageKey = getAvatarStorageKey(activeShopId);
    const removedKey = getAvatarRemovedKey(activeShopId);
    if (avatarUrl) {
      setLiveAvatarUrl(avatarUrl);
      try {
        window.localStorage.setItem(storageKey, avatarUrl);
        window.localStorage.removeItem(removedKey);
      } catch {
        // Ignore
      }
    } else {
      try {
        const wasRemoved = window.localStorage.getItem(removedKey) === "true";
        const cached = window.localStorage.getItem(storageKey);
        setLiveAvatarUrl(!wasRemoved && cached ? cached : null);
      } catch {
        setLiveAvatarUrl(null);
      }
    }
  }, [avatarUrl, activeShopId]);

  useEffect(() => {
    function onAvatarUpdated(e: Event) {
      const detail = (e as CustomEvent<{ avatarUrl: string | null; shopId?: string }>).detail;
      if (detail?.shopId && detail.shopId !== activeShopId) return;
      setAvatarBroken(false);
      setLiveAvatarUrl(detail?.avatarUrl ?? null);
    }
    window.addEventListener(AVATAR_UPDATED_EVENT, onAvatarUpdated);
    return () => window.removeEventListener(AVATAR_UPDATED_EVENT, onAvatarUpdated);
  }, [activeShopId]);

  function openShopSheet(initialMode: "list" | "create" = "list") {
    setSheetError(null);
    setIgSheetMode(initialMode);
    setIgSheetOpen(true);
    try {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(15);
      }
    } catch {
      // Ignore vibration errors
    }
  }

  function closeShopSheet() {
    if (isPending) return;
    setIgSheetOpen(false);
    setSheetError(null);
  }

  function handleQuickSwitch(targetShopId: string) {
    if (targetShopId === activeShopId || isPending) {
      setIgSheetOpen(false);
      return;
    }
    setSheetError(null);
    setSwitchingShopId(targetShopId);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("shop_id", targetShopId);
      const res = await switchShopAction(fd);
      setSwitchingShopId(null);
      if (res.ok) {
        setIgSheetOpen(false);
        setOpen(false);
        router.refresh();
      } else {
        setSheetError(res.error ?? "สลับร้านไม่สำเร็จ");
      }
    });
  }

  function handleQuickCreateShop(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!newShopName.trim() || isPending) return;
    setSheetError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("shop_name", newShopName.trim());
      fd.set("unit_label", newUnitLabel.trim() || DEFAULT_UNIT_LABEL);
      fd.set("share_ingredients_mode", shareMode);
      if (shareMode === "shared") {
        fd.set("share_ingredients_from", shareTargetShopId || DEFAULT_SHOP_ID);
      } else {
        fd.set("share_ingredients_from", "isolated");
        if (copyIngredients || copyMenus) fd.set("copy_ingredients", "true");
      }
      if (copyMenus) fd.set("copy_menus", "true");

      const res = await createShopAction(fd);
      if (res.ok) {
        setNewShopName("");
        setNewUnitLabel("กล่อง");
        setShareMode("shared");
        setShareTargetShopId(DEFAULT_SHOP_ID);
        setCopyIngredients(true);
        setCopyMenus(false);
        setIgSheetMode("list");
        setIgSheetOpen(false);
        setOpen(false);
        router.refresh();
      } else {
        setSheetError(res.error ?? "สร้างร้านไม่สำเร็จ");
      }
    });
  }

  // Instagram-style bottom-right profile tab handlers:
  // - Long press (~360ms): opens Shop Switcher Sheet from ANY page
  // - Double tap: opens Shop Switcher Sheet from ANY page
  // - Single tap when already on /settings: opens Shop Switcher Sheet
  // - Single tap on other pages: navigates to /settings
  function handleProfilePointerDown() {
    longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      openShopSheet("list");
    }, 360);
  }

  function handleProfilePointerUpOrLeave() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function handleProfileTabClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (longPressTriggeredRef.current) {
      e.preventDefault();
      longPressTriggeredRef.current = false;
      return;
    }
    const now = Date.now();
    const isDoubleTap = now - lastTapTimeRef.current < 320;
    lastTapTimeRef.current = now;

    if (isDoubleTap || pathname.startsWith("/settings")) {
      e.preventDefault();
      openShopSheet("list");
    }
  }

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

  const active = (href: string) =>
    href === "/dashboard" || href === "/sales" ? pathname === href : pathname.startsWith(href);
  const initial = Array.from((displayName || shopName || "ก").trim())[0] ?? "ก";
  const showAvatar = Boolean(liveAvatarUrl && !avatarBroken);
  const itemByHref = new Map(navItems.map((item) => [item.href, item]));
  const bottomNavItems = [
    itemByHref.get("/dashboard")!,
    itemByHref.get("/sales")!,
    { ...itemByHref.get("/sales/new")!, label: "เปิดบิล" },
    { ...itemByHref.get("/menus")!, label: "เมนู" },
  ].filter(Boolean);

  const normalizedShops: ShopSummary[] =
    shops.length > 0
      ? shops
      : [
          {
            id: activeShopId,
            shopName: shopName || "kaikai",
            displayName: displayName || shopName || "kaikai",
            avatarUrl: liveAvatarUrl,
            unitLabel: "กล่อง",
            createdAt: "",
          },
        ];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${open ? "is-open" : ""}`}>
        <div className="sidebar-head">
          <Brand />
          <button
            className="icon-button mobile-only"
            onClick={() => setOpen(false)}
            aria-label="ปิดเมนู"
          >
            <X />
          </button>
        </div>

        <div className="mobile-drawer-label mobile-only">เมนูเพิ่มเติม</div>
        <nav className="side-nav" aria-label="เมนูหลัก">
          {navItems.map(({ href, label, icon: Icon, inBottomBar }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className={`${active(href) ? "active" : ""} ${inBottomBar ? "hide-in-mobile-drawer" : ""}`}
            >
              <Icon size={20} strokeWidth={2} />
              <span>{label}</span>
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

        {/* Sidebar Footer: Click anywhere on profile bar to open IG-style Shop Switcher */}
        <button
          type="button"
          className="sidebar-footer sidebar-footer-btn"
          onClick={() => openShopSheet("list")}
          title="กดเพื่อสลับร้านหรือเพิ่มร้านใหม่"
        >
          <div className="avatar">
            {showAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={liveAvatarUrl!}
                alt=""
                className="avatar-img"
                onError={() => setAvatarBroken(true)}
              />
            ) : (
              initial
            )}
          </div>
          <div className="sidebar-footer-meta">
            <strong>{shopName || displayName}</strong>
            <span>
              {demoMode
                ? "ยังไม่เชื่อมฐานข้อมูล"
                : normalizedShops.length > 1
                ? `สลับร้านค้า (${normalizedShops.length} ร้าน)`
                : "กดเพื่อสลับ / เพิ่มร้านใหม่"}
            </span>
          </div>
          <span className="sidebar-manage-shops-link" aria-hidden="true">
            <ChevronDown size={15} />
          </span>
        </button>
      </aside>
      {open && <button className="scrim" onClick={() => setOpen(false)} aria-label="ปิดเมนู" />}
      <div className="main-column">
        <header className="topbar">
          <div className="mobile-only topbar-mobile-logo">
            <Link href="/dashboard" aria-label="หน้าหลัก">
              <Brand compact />
            </Link>
          </div>
          <div className="topbar-spacer desktop-only" />
          {demoMode && <span className="demo-pill desktop-only">ยังไม่เชื่อมฐานข้อมูล</span>}

          <span className="topbar-shop">{shopName || displayName || "kaikai"}</span>

          <button
            type="button"
            className="avatar small desktop-only topbar-avatar-btn"
            onClick={() => openShopSheet("list")}
            title="กดเพื่อสลับร้านหรือเพิ่มร้านใหม่"
            aria-label="สลับร้านหรือตั้งค่าบัญชี"
          >
            {showAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={liveAvatarUrl!}
                alt=""
                className="avatar-img"
                onError={() => setAvatarBroken(true)}
              />
            ) : (
              initial
            )}
          </button>
          <button
            type="button"
            className="topbar-menu-btn mobile-only"
            onClick={() => setOpen(true)}
            aria-label="เปิดเมนู"
          >
            <Menu size={20} />
          </button>
        </header>
        {demoMode && (
          <div className="demo-banner">
            ยังไม่ได้เชื่อม Supabase — ตั้งค่า .env.local แล้วรีสตาร์ตเซิร์ฟเวอร์เพื่อบันทึกข้อมูลจริง
          </div>
        )}
        <main className="page-content">{children}</main>
      </div>

      {/* Mobile Bottom Nav with Instagram-style long-press / double-tap on Profile tab */}
      <nav className="bottom-nav" aria-label="เมนูมือถือ">
        {bottomNavItems.map(({ href, label, icon: Icon, accent }) => (
          <Link
            key={href}
            href={href}
            className={`${active(href) ? "active" : ""} ${accent ? "accent" : ""}`}
          >
            <Icon size={accent ? 25 : 21} />
            <span>{label}</span>
          </Link>
        ))}
        <Link
          href="/settings"
          className={`nav-profile-tab ${active("/settings") ? "active" : ""}`}
          aria-label="โปรไฟล์ (กดค้างเพื่อสลับร้าน)"
          title="กดค้างเพื่อสลับร้านหรือเพิ่มร้านใหม่"
          onPointerDown={handleProfilePointerDown}
          onPointerUp={handleProfilePointerUpOrLeave}
          onPointerLeave={handleProfilePointerUpOrLeave}
          onPointerCancel={handleProfilePointerUpOrLeave}
          onContextMenu={(e) => {
            e.preventDefault();
            openShopSheet("list");
          }}
          onClick={handleProfileTabClick}
        >
          <span className="nav-avatar-wrap">
            <span className="nav-avatar">
              {showAvatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={liveAvatarUrl!}
                  alt=""
                  className="avatar-img"
                  onError={() => setAvatarBroken(true)}
                />
              ) : (
                initial
              )}
            </span>
            <span className="nav-avatar-ig-badge" aria-hidden="true">
              {normalizedShops.length > 1 ? normalizedShops.length : "+"}
            </span>
          </span>
          <span>โปรไฟล์</span>
        </Link>
      </nav>

      {/* Instagram-style Bottom Sheet / Modal for Account & Shop Switching */}
      {igSheetOpen && (
        <div
          className="ig-sheet-backdrop"
          onClick={closeShopSheet}
          role="dialog"
          aria-modal="true"
          aria-label="สลับร้านค้าและเพิ่มร้านใหม่"
        >
          <div className="ig-sheet-card" onClick={(e) => e.stopPropagation()}>
            <div className="ig-sheet-grabber-wrap" onClick={closeShopSheet}>
              <span className="ig-sheet-grabber" />
            </div>

            {igSheetMode === "list" ? (
              <>
                <div className="ig-sheet-header">
                  <strong>สลับร้านค้า</strong>
                  <button
                    type="button"
                    className="icon-button ig-sheet-close"
                    onClick={closeShopSheet}
                    aria-label="ปิด"
                  >
                    <X size={18} />
                  </button>
                </div>

                {sheetError && (
                  <div className="form-error ig-sheet-error" role="alert">
                    {sheetError}
                  </div>
                )}

                <div className="ig-sheet-list">
                  {normalizedShops.map((s) => {
                    const isCurrent = s.id === activeShopId;
                    const isLoading = isPending && switchingShopId === s.id;
                    const sInitial = Array.from((s.shopName || "ร").trim())[0] ?? "ร";
                    const sAvatar =
                      isCurrent && showAvatar ? liveAvatarUrl : s.avatarUrl;

                    return (
                      <button
                        key={s.id}
                        type="button"
                        className={`ig-account-row ${isCurrent ? "is-active" : ""}`}
                        onClick={() => handleQuickSwitch(s.id)}
                        disabled={isPending}
                      >
                        <span className={`ig-account-avatar-ring ${isCurrent ? "is-active" : ""}`}>
                          <span className="ig-account-avatar">
                            {sAvatar ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={sAvatar} alt="" className="avatar-img" />
                            ) : (
                              sInitial
                            )}
                          </span>
                        </span>

                        <span className="ig-account-info">
                          <span className="ig-account-name-line">
                            <strong>{s.shopName}</strong>
                            {s.id === DEFAULT_SHOP_ID && (
                              <span className="ig-account-tag">ร้านหลัก</span>
                            )}
                          </span>
                          <small>
                            {isLoading
                              ? "กำลังสลับร้าน…"
                              : `หน่วยหลัก: ${s.unitLabel || "ชิ้น"}${
                                  s.displayName && s.displayName !== s.shopName
                                    ? ` · ${s.displayName}`
                                    : ""
                                }`}
                          </small>
                        </span>

                        <span
                          className={`ig-account-radio ${isCurrent ? "is-checked" : ""}`}
                          aria-hidden="true"
                        >
                          {isCurrent && <Check size={14} strokeWidth={3} />}
                        </span>
                      </button>
                    );
                  })}

                  {/* Instagram-style "+ เพิ่มร้านใหม่" row directly inside the list */}
                  <button
                    type="button"
                    className="ig-account-row ig-add-shop-row"
                    onClick={() => {
                      setSheetError(null);
                      setIgSheetMode("create");
                    }}
                    disabled={isPending}
                  >
                    <span className="ig-add-shop-circle">
                      <Plus size={22} strokeWidth={2.4} />
                    </span>
                    <span className="ig-account-info">
                      <strong>เพิ่มร้านใหม่</strong>
                      <small>เปิดอีกร้านในอีเมลเดียวกัน แยกเมนูและบัญชีอิสระ</small>
                    </span>
                  </button>
                </div>

                <div className="ig-sheet-footer">
                  <Link
                    href="/settings"
                    className="ig-sheet-settings-link"
                    onClick={() => setIgSheetOpen(false)}
                  >
                    <Settings size={15} />
                    <span>ไปที่หน้าตั้งค่าร้านและบัญชี</span>
                  </Link>
                </div>
              </>
            ) : (
              <form onSubmit={handleQuickCreateShop} className="ig-create-form">
                <div className="ig-sheet-header">
                  <button
                    type="button"
                    className="icon-button ig-sheet-back"
                    onClick={() => {
                      setSheetError(null);
                      setIgSheetMode("list");
                    }}
                    aria-label="ย้อนกลับ"
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <strong>เพิ่มร้านใหม่</strong>
                  <button
                    type="button"
                    className="icon-button ig-sheet-close"
                    onClick={closeShopSheet}
                    aria-label="ปิด"
                  >
                    <X size={18} />
                  </button>
                </div>

                {sheetError && (
                  <div className="form-error ig-sheet-error" role="alert">
                    {sheetError}
                  </div>
                )}

                <div className="ig-create-body">
                  <label className="ig-field-label">
                    <span>ชื่อร้านใหม่</span>
                    <input
                      type="text"
                      value={newShopName}
                      onChange={(e) => setNewShopName(e.target.value)}
                      placeholder="เช่น ร้านเครป, กะเพราถาด, ร้านน้ำปั่น"
                      maxLength={80}
                      required
                      autoFocus
                    />
                  </label>

                  <div className="ig-field-label">
                    <span>คำเรียกหน่วยสินค้าหลักของร้านนี้</span>
                    <input
                      type="text"
                      value={newUnitLabel}
                      onChange={(e) => setNewUnitLabel(e.target.value)}
                      placeholder="เช่น กล่อง, จาน, แผ่น, แก้ว"
                      maxLength={20}
                    />
                    <div className="unit-quick-chips">
                      {UNIT_LABEL_OPTIONS.slice(0, 6).map((u) => (
                        <button
                          key={u}
                          type="button"
                          className={`unit-chip ${newUnitLabel === u ? "is-selected" : ""}`}
                          onClick={() => setNewUnitLabel(u)}
                        >
                          {u}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="shop-copy-options">
                    <div className="shop-sharing-mode-box">
                      <span className="shop-sharing-mode-title">คลังวัตถุดิบและบรรจุภัณฑ์</span>
                      <label className={`shop-mode-radio-card ${shareMode === "shared" ? "is-selected" : ""}`}>
                        <input
                          type="radio"
                          name="ig_share_mode"
                          checked={shareMode === "shared"}
                          onChange={() => setShareMode("shared")}
                        />
                        <div>
                          <strong>
                            <Link2
                              size={13}
                              style={{ display: "inline", verticalAlign: "-2px", marginRight: "5px" }}
                            />
                            เชื่อมคลังวัตถุดิบร่วมกับร้านเดิม
                          </strong>
                          <small className="muted-hint" style={{ display: "block", marginTop: "2px" }}>
                            ใช้วัตถุดิบและซิงค์ราคาต้นทุนร่วมกัน (บิลรายจ่ายแยกตามร้าน)
                          </small>
                        </div>
                      </label>

                      <label className={`shop-mode-radio-card ${shareMode === "isolated" ? "is-selected" : ""}`}>
                        <input
                          type="radio"
                          name="ig_share_mode"
                          checked={shareMode === "isolated"}
                          onChange={() => setShareMode("isolated")}
                        />
                        <div>
                          <strong>
                            <Unlink
                              size={13}
                              style={{ display: "inline", verticalAlign: "-2px", marginRight: "5px" }}
                            />
                            แยกคลังวัตถุดิบเฉพาะร้านนี้
                          </strong>
                          <small className="muted-hint" style={{ display: "block", marginTop: "2px" }}>
                            รายการวัตถุดิบและราคาต้นทุนแยกอิสระไม่ปนกัน
                          </small>
                        </div>
                      </label>

                      {shareMode === "shared" &&
                        normalizedShops.filter(
                          (s) => resolveInventoryShopId(s.id, normalizedShops) === s.id,
                        ).length > 1 && (
                          <div className="shop-share-target-row">
                            <span className="muted-hint">เลือกคลังวัตถุดิบที่ต้องการเชื่อม:</span>
                            <select
                              className="shop-sharing-select"
                              value={shareTargetShopId}
                              onChange={(e) => setShareTargetShopId(e.target.value)}
                            >
                              {normalizedShops
                                .filter((s) => resolveInventoryShopId(s.id, normalizedShops) === s.id)
                                .map((s) => (
                                  <option key={s.id} value={s.id}>
                                    คลังของร้าน “{s.shopName}”
                                  </option>
                                ))}
                            </select>
                          </div>
                        )}
                    </div>

                    {shareMode === "isolated" && (
                      <label className="checkbox-toggle-wrap">
                        <input
                          type="checkbox"
                          checked={copyIngredients || copyMenus}
                          disabled={copyMenus}
                          onChange={(e) => setCopyIngredients(e.target.checked)}
                        />
                        <div>
                          <strong>
                            <Copy
                              size={13}
                              style={{ display: "inline", verticalAlign: "-2px", marginRight: "5px" }}
                            />
                            คัดลอกวัตถุดิบตั้งต้นจากร้าน “{shopName || "ปัจจุบัน"}”
                          </strong>
                          <small className="muted-hint" style={{ display: "block", marginTop: "2px" }}>
                            คัดลอกเป็นสำเนาแยกต่างหาก แก้ไขทีหลังได้อิสระ
                          </small>
                        </div>
                      </label>
                    )}

                    <label className="checkbox-toggle-wrap">
                      <input
                        type="checkbox"
                        checked={copyMenus}
                        onChange={(e) => {
                          setCopyMenus(e.target.checked);
                          if (e.target.checked && shareMode === "isolated") setCopyIngredients(true);
                        }}
                      />
                      <div>
                        <strong>คัดลอกเมนูและสูตรอาหารไปด้วย</strong>
                        <small className="muted-hint" style={{ display: "block", marginTop: "2px" }}>
                          เหมาะกับร้านสาขาใหม่ หรือร้านที่ใช้เมนูใกล้เคียงกัน
                        </small>
                      </div>
                    </label>
                  </div>

                  <button
                    type="submit"
                    className="primary-button ig-create-submit"
                    disabled={isPending || !newShopName.trim()}
                  >
                    <Plus size={17} strokeWidth={2.5} />
                    <span>{isPending ? "กำลังสร้างร้าน…" : "สร้างร้านและสลับไปร้านใหม่"}</span>
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
