"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_LOYALTY_RULES_TEXT,
  type LoyaltyCouponRecord,
  formatThaiDateTime,
  formatValidTillDate,
  parseLoyaltyQueryParams,
} from "@/lib/loyalty";

interface LiffProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
}

interface LiffSdk {
  init: (config: { liffId: string }) => Promise<void>;
  isInClient: () => boolean;
  isLoggedIn: () => boolean;
  login: (config?: { redirectUri?: string }) => void;
  getProfile: () => Promise<LiffProfile>;
  getContext?: () => { type?: string } | null;
  sendMessages: (messages: Array<Record<string, unknown>>) => Promise<void>;
  scanCodeV2?: () => Promise<{ value: string | null }>;
}

declare global {
  interface Window {
    liff?: LiffSdk;
  }
}

interface CardConfigState {
  cardTitle: string;
  cardHeadline: string;
  rewardTitle: string;
  stampsPerReward: number;
  validityMonths: number;
  cooldownMinutes: number;
  rulesText: string;
  liffId: string;
  botBasicId: string;
}

interface MemberState {
  lineUserId: string;
  displayName: string;
  pictureUrl: string | null;
  stamps: number;
  lifetimeStamps: number;
  expiresAt: string | null;
  validTillFormatted: string;
  lastStampedAt: string | null;
  expiredReset: boolean;
}

interface ClaimBannerState {
  type: "success" | "warning" | "error";
  title: string;
  subtitle: string;
  pointsAdded?: number;
  rewardsUnlocked?: number;
  chatNotified?: boolean;
  pushReason?: string;
}

export interface LoyaltyStampCardClientProps {
  initialShopSecret: string;
  initialPoints: number | null;
  initialToken: string;
  initialLiffId: string;
}

const LOCAL_DEVICE_USER_KEY = "kaikai_loyalty_device_user_v1";
const LOCAL_DISPLAY_NAME_KEY = "kaikai_loyalty_display_name_v1";

function getOrCreateBrowserUserId(): string {
  if (typeof window === "undefined") return "web_guest";
  try {
    const existing = window.localStorage.getItem(LOCAL_DEVICE_USER_KEY);
    if (existing && existing.length >= 8) return existing;
    const bytes = new Uint8Array(12);
    window.crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const nextId = `web_${hex}`;
    window.localStorage.setItem(LOCAL_DEVICE_USER_KEY, nextId);
    return nextId;
  } catch {
    return "web_guest_fallback";
  }
}

function getSavedDisplayName(): string {
  if (typeof window === "undefined") return "ลูกค้า LINE";
  try {
    return window.localStorage.getItem(LOCAL_DISPLAY_NAME_KEY)?.trim() || "ลูกค้า LINE";
  } catch {
    return "ลูกค้า LINE";
  }
}

async function loadLiffSdkScript(): Promise<LiffSdk | null> {
  if (typeof window === "undefined") return null;
  if (window.liff) return window.liff;

  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-liff-sdk="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(window.liff ?? null), { once: true });
      existing.addEventListener("error", () => resolve(null), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
    script.async = true;
    script.dataset.liffSdk = "true";
    script.onload = () => resolve(window.liff ?? null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

export function LoyaltyStampCardClient({
  initialShopSecret,
  initialPoints,
  initialToken,
  initialLiffId,
}: LoyaltyStampCardClientProps) {
  const [shopSecret, setShopSecret] = useState(initialShopSecret);
  const [config, setConfig] = useState<CardConfigState>({
    cardTitle: "GaiTomNamPla 🐔",
    cardHeadline: "สะสม 10 กล่อง ลด 50%",
    rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
    stampsPerReward: 10,
    validityMonths: 3,
    cooldownMinutes: 5,
    rulesText: DEFAULT_LOYALTY_RULES_TEXT,
    liffId: initialLiffId,
    botBasicId: "",
  });

  const [member, setMember] = useState<MemberState>({
    lineUserId: "",
    displayName: "ลูกค้า LINE",
    pictureUrl: null,
    stamps: 0,
    lifetimeStamps: 0,
    expiresAt: null,
    validTillFormatted: formatValidTillDate(null),
    lastStampedAt: null,
    expiredReset: false,
  });

  const [coupons, setCoupons] = useState<LoyaltyCouponRecord[]>([]);
  const [activeTab, setActiveTab] = useState<"unclaimed" | "claimed">("unclaimed");
  const [gridExpanded, setGridExpanded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [claimBanner, setClaimBanner] = useState<ClaimBannerState | null>(null);
  const [isInLineClient, setIsInLineClient] = useState(false);

  // Modals
  const [confirmRedeemCoupon, setConfirmRedeemCoupon] = useState<LoyaltyCouponRecord | null>(null);
  const [redeemingCouponId, setRedeemingCouponId] = useState<string | null>(null);
  const [receiptCoupon, setReceiptCoupon] = useState<{
    code: string;
    title: string;
    claimedAtFormatted: string;
    displayName: string;
    chatNotified: boolean;
  } | null>(null);
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [manualQrInput, setManualQrInput] = useState("");
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showNameModal, setShowNameModal] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [liveClock, setLiveClock] = useState("");

  const hasProcessedInitialQr = useRef(false);

  // Live clock for the screenshot receipt modal so shop owner knows it's a real screen
  useEffect(() => {
    if (!receiptCoupon) return;
    const updateClock = () => {
      setLiveClock(formatThaiDateTime(new Date()));
    };
    updateClock();
    const timer = window.setInterval(updateClock, 1000);
    return () => window.clearInterval(timer);
  }, [receiptCoupon]);

  const fetchCardState = useCallback(
    async (resolvedShopSecret: string, userProfile: { userId: string; displayName: string; pictureUrl: string | null }) => {
      const response = await fetch("/api/loyalty/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopSecret: resolvedShopSecret,
          lineUserId: userProfile.userId,
          displayName: userProfile.displayName,
          pictureUrl: userProfile.pictureUrl,
        }),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!data.ok) {
        setErrorMessage(String(data.message ?? "ไม่สามารถโหลดข้อมูลบัตรสะสมแต้มได้"));
        return null;
      }

      const cfg = (data.config ?? {}) as Record<string, unknown>;
      const mem = (data.member ?? {}) as Record<string, unknown>;
      const rawCoupons = Array.isArray(data.coupons) ? (data.coupons as Array<Record<string, unknown>>) : [];

      const nextConfig: CardConfigState = {
        cardTitle: String(cfg.cardTitle ?? "GaiTomNamPla 🐔"),
        cardHeadline: String(cfg.cardHeadline ?? "สะสม 10 กล่อง ลด 50%"),
        rewardTitle: String(cfg.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง"),
        stampsPerReward: Math.max(1, Number(cfg.stampsPerReward ?? 10)),
        validityMonths: Math.max(1, Number(cfg.validityMonths ?? 3)),
        cooldownMinutes: Math.max(0, Number(cfg.cooldownMinutes ?? 5)),
        rulesText: String(cfg.rulesText ?? DEFAULT_LOYALTY_RULES_TEXT),
        liffId: String(cfg.liffId ?? initialLiffId ?? ""),
        botBasicId: String(cfg.botBasicId ?? ""),
      };
      setConfig(nextConfig);

      const nextMember: MemberState = {
        lineUserId: String(mem.lineUserId ?? userProfile.userId),
        displayName: String(mem.displayName ?? userProfile.displayName),
        pictureUrl: mem.pictureUrl ? String(mem.pictureUrl) : userProfile.pictureUrl,
        stamps: Math.max(0, Number(mem.stamps ?? 0)),
        lifetimeStamps: Math.max(0, Number(mem.lifetimeStamps ?? 0)),
        expiresAt: mem.expiresAt ? String(mem.expiresAt) : null,
        validTillFormatted: String(mem.validTillFormatted ?? formatValidTillDate(mem.expiresAt ? String(mem.expiresAt) : null)),
        lastStampedAt: mem.lastStampedAt ? String(mem.lastStampedAt) : null,
        expiredReset: Boolean(mem.expiredReset),
      };
      setMember(nextMember);

      const mappedCoupons: LoyaltyCouponRecord[] = rawCoupons.map((c) => ({
        id: String(c.id),
        code: String(c.code ?? ""),
        title: String(c.title ?? nextConfig.rewardTitle),
        status: c.status === "claimed" ? "claimed" : "unclaimed",
        issuedAt: String(c.issuedAt ?? new Date().toISOString()),
        claimedAt: c.claimedAt ? String(c.claimedAt) : null,
      }));
      setCoupons(mappedCoupons);
      setErrorMessage(null);
      return { config: nextConfig, member: nextMember, coupons: mappedCoupons };
    },
    [initialLiffId],
  );

  const executeStampClaim = useCallback(
    async (
      targetShopSecret: string,
      points: number,
      token: string,
      userProfile: { userId: string; displayName: string; pictureUrl: string | null },
      currentLiffId = "",
    ) => {
      setClaiming(true);
      try {
        const response = await fetch("/api/loyalty/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shopSecret: targetShopSecret,
            points,
            token,
            lineUserId: userProfile.userId,
            displayName: userProfile.displayName,
            pictureUrl: userProfile.pictureUrl,
            liffId: currentLiffId,
            sendPush: true,
          }),
        });
        const data = (await response.json()) as Record<string, unknown>;

        if (!data.ok) {
          setClaimBanner({
            type: data.code === "COOLDOWN_ACTIVE" ? "warning" : "error",
            title: data.code === "COOLDOWN_ACTIVE" ? "สแกนซ้ำเร็วเกินไป" : "ไม่สามารถสะสมแต้มได้",
            subtitle: String(data.message ?? "คิวอาร์โค้ดไม่ถูกต้องหรือหมดอายุ"),
          });
          return;
        }

        const pointsAdded = Number(data.pointsAdded ?? points);
        const newStamps = Number(data.newStamps ?? 0);
        const stampsPerReward = Number(data.stampsPerReward ?? 10);
        const rewardsUnlocked = Number(data.rewardsUnlocked ?? 0);

        const notification = data.notification as
          | { plainText?: string; flexMessage?: Record<string, unknown>; pushed?: boolean; pushReason?: string }
          | undefined;
        const chatNotified = Boolean(notification?.pushed);

        setClaimBanner({
          type: "success",
          title: `🎉 สะสมสำเร็จ +${pointsAdded} แต้ม!`,
          subtitle:
            rewardsUnlocked > 0
              ? `ครบ ${stampsPerReward} แต้ม! ได้รับคูปองส่วนลดใหม่ +${rewardsUnlocked} ใบ และมีแต้มสะสมต่อ ${newStamps}/${stampsPerReward} แต้ม`
              : `แต้มสะสมปัจจุบันของคุณคือ ${newStamps} / ${stampsPerReward} แต้ม (อีก ${Math.max(0, stampsPerReward - newStamps)} แต้มรับส่วนลด 50%)`,
          pointsAdded,
          rewardsUnlocked,
          chatNotified,
          pushReason: notification?.pushReason,
        });

        await fetchCardState(targetShopSecret, userProfile);

        // Clean QR token from browser URL so refreshing the page doesn't trigger cooldown warning
        if (typeof window !== "undefined") {
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete("p");
          cleanUrl.searchParams.delete("t");
          cleanUrl.searchParams.delete("liff.state");
          cleanUrl.searchParams.set("s", targetShopSecret);
          window.history.replaceState({}, "", cleanUrl.toString());
        }
      } catch {
        setClaimBanner({
          type: "error",
          title: "เกิดข้อผิดพลาดในการเชื่อมต่อ",
          subtitle: "กรุณาลองสแกนใหม่อีกครั้ง",
        });
      } finally {
        setClaiming(false);
      }
    },
    [fetchCardState],
  );

  // Initialize URL params, LIFF SDK (if configured), card state, and auto-claim QR if present
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setLoading(true);
      const parsedFromUrl =
        typeof window !== "undefined"
          ? parseLoyaltyQueryParams(new URL(window.location.href).searchParams)
          : { shopSecret: initialShopSecret, points: initialPoints, token: initialToken };

      let resolvedShopSecret = parsedFromUrl.shopSecret || initialShopSecret;
      let resolvedPoints = parsedFromUrl.points ?? initialPoints;
      let resolvedToken = parsedFromUrl.token || initialToken;

      // Restore pending QR claim from sessionStorage if returning from LINE Login redirect
      if (typeof window !== "undefined") {
        try {
          const savedRaw = window.sessionStorage.getItem("kaikai_pending_qr_claim_v1");
          if (savedRaw) {
            const saved = JSON.parse(savedRaw) as {
              shopSecret?: string;
              points?: number | null;
              token?: string;
              savedAt?: number;
            };
            if (saved && (!saved.savedAt || Date.now() - saved.savedAt < 5 * 60 * 1000)) {
              if (!resolvedShopSecret && saved.shopSecret) resolvedShopSecret = saved.shopSecret;
              if (!resolvedPoints && saved.points) resolvedPoints = saved.points;
              if (!resolvedToken && saved.token) resolvedToken = saved.token;
            }
          }
        } catch {
          // Ignore sessionStorage error
        }
      }

      if (resolvedShopSecret) {
        setShopSecret(resolvedShopSecret);
      }

      if (!resolvedShopSecret) {
        setErrorMessage("ไม่พบรหัสร้านค้าในลิงก์ กรุณาเปิดจากลิงก์หรือคิวอาร์โค้ดของร้าน");
        setLoading(false);
        return;
      }

      // Save pending QR claim before any LINE redirect so p and t are never lost
      if (typeof window !== "undefined" && resolvedPoints && resolvedToken) {
        try {
          window.sessionStorage.setItem(
            "kaikai_pending_qr_claim_v1",
            JSON.stringify({
              shopSecret: resolvedShopSecret,
              points: resolvedPoints,
              token: resolvedToken,
              savedAt: Date.now(),
            }),
          );
        } catch {
          // Ignore sessionStorage error
        }
      }

      const fallbackUserId = getOrCreateBrowserUserId();
      const fallbackName = getSavedDisplayName();
      let userProfile = {
        userId: fallbackUserId,
        displayName: fallbackName,
        pictureUrl: null as string | null,
      };

      // Fetch shop config first (without creating a guest member row yet) to check if liffId is configured
      const initialState = await fetchCardState(resolvedShopSecret, {
        userId: "",
        displayName: fallbackName,
        pictureUrl: null,
      });
      if (cancelled) return;

      const effectiveLiffId = initialLiffId || initialState?.config.liffId || "";
      if (effectiveLiffId) {
        const liff = await loadLiffSdkScript();
        if (liff && !cancelled) {
          try {
            await liff.init({ liffId: effectiveLiffId });
            const inClient = liff.isInClient();
            setIsInLineClient(inClient);

            // If opened inside the LINE app via a direct web URL instead of liff.line.me, upgrade to LIFF URL automatically
            if (
              !inClient &&
              typeof navigator !== "undefined" &&
              /Line\//i.test(navigator.userAgent) &&
              typeof window !== "undefined" &&
              !window.location.search.includes("liff.state") &&
              !window.location.search.includes("code=")
            ) {
              const targetParams = new URLSearchParams();
              targetParams.set("s", resolvedShopSecret);
              if (resolvedPoints && resolvedToken) {
                targetParams.set("p", String(resolvedPoints));
                targetParams.set("t", resolvedToken);
              }
              window.location.replace(`https://liff.line.me/${effectiveLiffId}?${targetParams.toString()}`);
              return;
            }

            if (liff.isLoggedIn()) {
              const profile = await liff.getProfile();
              userProfile = {
                userId: profile.userId,
                displayName: profile.displayName || fallbackName,
                pictureUrl: profile.pictureUrl ?? null,
              };
              await fetchCardState(resolvedShopSecret, userProfile);
            } else {
              // Redirect to LINE Login so we always get the customer's real LINE userId (U...) for OA Push notifications
              const redirectUrl = new URL(window.location.href);
              redirectUrl.searchParams.set("s", resolvedShopSecret);
              if (resolvedPoints && resolvedToken) {
                redirectUrl.searchParams.set("p", String(resolvedPoints));
                redirectUrl.searchParams.set("t", resolvedToken);
              }
              liff.login({ redirectUri: redirectUrl.toString() });
              return;
            }
          } catch {
            // Continue smoothly with browser device ID if LIFF init fails or domain doesn't match yet
            await fetchCardState(resolvedShopSecret, userProfile);
          }
        }
      } else {
        await fetchCardState(resolvedShopSecret, userProfile);
      }

      if (!cancelled && !hasProcessedInitialQr.current && resolvedPoints && resolvedToken) {
        hasProcessedInitialQr.current = true;
        if (typeof window !== "undefined") {
          try {
            window.sessionStorage.removeItem("kaikai_pending_qr_claim_v1");
          } catch {
            // Ignore
          }
        }
        await executeStampClaim(resolvedShopSecret, resolvedPoints, resolvedToken, userProfile, effectiveLiffId);
      }

      if (!cancelled) {
        setLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [executeStampClaim, fetchCardState, initialLiffId, initialPoints, initialShopSecret, initialToken]);

  const unclaimedCoupons = useMemo(
    () => coupons.filter((c) => c.status === "unclaimed"),
    [coupons],
  );
  const claimedCoupons = useMemo(
    () => coupons.filter((c) => c.status === "claimed"),
    [coupons],
  );

  const stampsRemaining = Math.max(0, config.stampsPerReward - member.stamps);
  const rulesLines = useMemo(
    () =>
      (config.rulesText || DEFAULT_LOYALTY_RULES_TEXT)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    [config.rulesText],
  );

  const handleScanButtonClick = async () => {
    if (window.liff && window.liff.isInClient() && typeof window.liff.scanCodeV2 === "function") {
      try {
        const res = await window.liff.scanCodeV2();
        if (res?.value) {
          await handleScannedQrText(res.value);
          return;
        }
      } catch {
        // Fallback to scanner modal if scanCodeV2 is not enabled or cancelled
      }
    }
    setShowScannerModal(true);
  };

  const handleScannedQrText = async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;

    try {
      const url = trimmed.startsWith("http")
        ? new URL(trimmed)
        : new URL(trimmed, window.location.origin);
      const parsed = parseLoyaltyQueryParams(url.searchParams);
      const targetSecret = parsed.shopSecret || shopSecret;
      if (parsed.points && parsed.token && targetSecret) {
        setShowScannerModal(false);
        setManualQrInput("");
        await executeStampClaim(targetSecret, parsed.points, parsed.token, {
          userId: member.lineUserId || getOrCreateBrowserUserId(),
          displayName: member.displayName || getSavedDisplayName(),
          pictureUrl: member.pictureUrl,
        });
        return;
      }
    } catch {
      // Check if #STAMP:<points>:<token> format
      const match = /#STAMP:(\d{1,2}):([A-Za-z0-9_-]+)/i.exec(trimmed);
      if (match && shopSecret) {
        setShowScannerModal(false);
        setManualQrInput("");
        await executeStampClaim(shopSecret, Number(match[1]), match[2], {
          userId: member.lineUserId || getOrCreateBrowserUserId(),
          displayName: member.displayName || getSavedDisplayName(),
          pictureUrl: member.pictureUrl,
        });
        return;
      }
    }

    setClaimBanner({
      type: "error",
      title: "ไม่พบข้อมูลคิวอาร์โค้ดสะสมแต้ม",
      subtitle: "กรุณาสแกนคิวอาร์โค้ดสะสมแต้มที่ได้รับจากทางร้าน",
    });
  };

  const handleConfirmRedeem = async () => {
    if (!confirmRedeemCoupon || !shopSecret) return;
    const coupon = confirmRedeemCoupon;
    setRedeemingCouponId(coupon.id);

    try {
      const response = await fetch("/api/loyalty/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopSecret,
          couponId: coupon.id,
          lineUserId: member.lineUserId || getOrCreateBrowserUserId(),
          displayName: member.displayName || getSavedDisplayName(),
          sendPush: true,
        }),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!data.ok) {
        setClaimBanner({
          type: "error",
          title: "ไม่สามารถใช้คูปองได้",
          subtitle: String(data.message ?? "กรุณาลองใหม่อีกครั้ง"),
        });
        setConfirmRedeemCoupon(null);
        return;
      }

      const notification = data.notification as
        | { plainText?: string; flexMessage?: Record<string, unknown>; pushed?: boolean }
        | undefined;
      const chatNotified = Boolean(notification?.pushed);

      await fetchCardState(shopSecret, {
        userId: member.lineUserId || getOrCreateBrowserUserId(),
        displayName: member.displayName || getSavedDisplayName(),
        pictureUrl: member.pictureUrl,
      });

      setConfirmRedeemCoupon(null);
      setActiveTab("claimed");
      setReceiptCoupon({
        code: String(data.code ?? coupon.code),
        title: String(data.title ?? coupon.title),
        claimedAtFormatted: String(data.claimedAtFormatted ?? formatThaiDateTime(new Date())),
        displayName: String(data.displayName ?? member.displayName),
        chatNotified,
      });
    } finally {
      setRedeemingCouponId(null);
    }
  };

  const handleSaveCustomDisplayName = async () => {
    const clean = nameDraft.trim();
    if (!clean) return;
    try {
      window.localStorage.setItem(LOCAL_DISPLAY_NAME_KEY, clean);
    } catch {
      // Ignore storage error
    }
    setShowNameModal(false);
    await fetchCardState(shopSecret, {
      userId: member.lineUserId || getOrCreateBrowserUserId(),
      displayName: clean,
      pictureUrl: member.pictureUrl,
    });
  };

  const totalSlots = Math.max(1, Math.min(30, config.stampsPerReward));

  return (
    <div className="line-stamp-shell">
      <div className="line-stamp-container">
        {/* Coral-Red Mascot Banner */}
        <div className="line-stamp-hero">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/loyalty/banner-chicken.jpg"
            alt="GaiTomNamPla Banner"
            className="line-stamp-hero-img"
          />
        </div>

        {/* Red Stamp Card (#E62134) */}
        <div className="line-stamp-card-wrap">
          <div className="line-stamp-card">
            {/* Overlapping Circular Bowl Avatar */}
            <div className="line-stamp-avatar-ring">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/loyalty/avatar-bowl.png"
                alt={config.cardTitle}
                className="line-stamp-avatar-img"
              />
            </div>

            <h1 className="line-stamp-title">{config.cardTitle}</h1>
            <p className="line-stamp-valid">Valid till {member.validTillFormatted}</p>
            <p className="line-stamp-headline">{config.cardHeadline}</p>

            {/* Customer identity pill (allows setting name when testing outside LINE) */}
            <div className="line-stamp-user-bar">
              <span>
                👤 {member.displayName}
                {isInLineClient ? " (LINE)" : ""}
              </span>
              {!isInLineClient && (
                <button
                  type="button"
                  className="line-stamp-edit-name-btn"
                  onClick={() => {
                    setNameDraft(member.displayName === "ลูกค้า LINE" ? "" : member.displayName);
                    setShowNameModal(true);
                  }}
                >
                  ตั้งชื่อของคุณ
                </button>
              )}
            </div>

            {/* ★REWARD progress bar */}
            <button
              type="button"
              className="line-stamp-progress-row"
              onClick={() => setGridExpanded((prev) => !prev)}
              aria-expanded={gridExpanded}
            >
              <div className="line-stamp-progress-left">
                <span className="line-stamp-reward-badge">★REWARD</span>
                <span className="line-stamp-progress-text">
                  {stampsRemaining} stamp(s) till reward
                </span>
              </div>
              <span className={`line-stamp-chevron ${gridExpanded ? "open" : ""}`} aria-hidden>
                ⌃
              </span>
            </button>

            {/* 2x5 Circular Stamp Grid */}
            {gridExpanded && (
              <div className="line-stamp-grid">
                {Array.from({ length: totalSlots }, (_, idx) => {
                  const slotNumber = idx + 1;
                  const isFilled = slotNumber <= member.stamps;
                  const isFinalSlot = slotNumber === totalSlots;

                  return (
                    <div
                      key={slotNumber}
                      className={`line-stamp-slot ${isFilled ? "filled" : "empty"} ${isFinalSlot ? "final" : ""}`}
                      aria-label={`Stamp ${slotNumber} of ${totalSlots}${isFilled ? " (สะสมแล้ว)" : ""}`}
                    >
                      <div className="line-stamp-emblem">
                        <div className="line-stamp-emblem-inner">
                          {isFinalSlot && !isFilled ? (
                            <span className="line-stamp-star">★</span>
                          ) : (
                            <span className="line-stamp-word">STAMP</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Notification Banner after scanning QR code */}
        {claiming && (
          <div className="line-stamp-alert info">
            <strong>⏳ กำลังบันทึกแต้มสะสมของคุณ...</strong>
            <span>กรุณารอสักครู่ ระบบกำลังอัปเดตบัตรสะสมแต้มและส่งแจ้งเตือนเข้าแชท</span>
          </div>
        )}

        {claimBanner && !claiming && (
          <div className={`line-stamp-alert ${claimBanner.type}`}>
            <div className="line-stamp-alert-head">
              <strong>{claimBanner.title}</strong>
              <button
                type="button"
                className="line-stamp-alert-close"
                onClick={() => setClaimBanner(null)}
                aria-label="ปิดแจ้งเตือน"
              >
                ✕
              </button>
            </div>
            <p>{claimBanner.subtitle}</p>
            {claimBanner.type === "success" && (
              <div className="line-stamp-alert-foot">
                {claimBanner.chatNotified ? (
                  <span className="line-stamp-chat-ok">
                    ✓ {config.cardTitle} ส่งข้อความแจ้งเตือนแต้มไปที่แชท LINE ของคุณแล้ว
                  </span>
                ) : claimBanner.pushReason === "MISSING_CHANNEL_ACCESS_TOKEN" ? (
                  <span className="line-stamp-chat-hint">
                    ℹ️ สำหรับร้านค้า: กรุณาใส่ Messaging API Channel Access Token ในหน้าตั้งค่า เพื่อให้ LINE OA ทักแจ้งแต้มหาลูกค้าอัตโนมัติ
                  </span>
                ) : claimBanner.pushReason === "NOT_LINE_USER_ID" ? (
                  <span className="line-stamp-chat-hint">
                    ℹ️ กรุณาสแกนผ่านลิงก์ LIFF ในแอป LINE เพื่อให้ LINE OA ทักแจ้งเตือนแต้มในแชทอัตโนมัติ
                  </span>
                ) : null}
              </div>
            )}
          </div>
        )}

        {errorMessage && (
          <div className="line-stamp-alert error">
            <strong>แจ้งเตือนระบบ</strong>
            <p>{errorMessage}</p>
          </div>
        )}

        {/* Unclaimed rewards | Claimed rewards Tabs */}
        <div className="line-stamp-tabs">
          <button
            type="button"
            className={`line-stamp-tab ${activeTab === "unclaimed" ? "active" : ""}`}
            onClick={() => setActiveTab("unclaimed")}
          >
            Unclaimed rewards
            {unclaimedCoupons.length > 0 && (
              <span className="line-stamp-tab-count">{unclaimedCoupons.length}</span>
            )}
          </button>
          <button
            type="button"
            className={`line-stamp-tab ${activeTab === "claimed" ? "active" : ""}`}
            onClick={() => setActiveTab("claimed")}
          >
            Claimed rewards
            {claimedCoupons.length > 0 && (
              <span className="line-stamp-tab-count muted">{claimedCoupons.length}</span>
            )}
          </button>
        </div>

        {/* Rewards Content */}
        <div className="line-stamp-rewards-section">
          {activeTab === "unclaimed" ? (
            <>
              {/* Ready-to-use Unclaimed Coupons (when customer has reached 10 stamps) */}
              {unclaimedCoupons.map((coupon) => (
                <div key={coupon.id} className="line-reward-item unlocked">
                  <div className="line-reward-thumb-wrap">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/loyalty/reward-bowl.png"
                      alt={coupon.title}
                      className="line-reward-thumb"
                    />
                    <span className="line-reward-ready-pill">พร้อมใช้</span>
                  </div>
                  <div className="line-reward-info">
                    <div className="line-reward-title">{coupon.title}</div>
                    <div className="line-reward-code">รหัสคูปอง #{coupon.code}</div>
                    <button
                      type="button"
                      className="line-reward-use-btn"
                      onClick={() => setConfirmRedeemCoupon(coupon)}
                    >
                      กดใช้คูปองส่วนลด (ตัดแต้ม)
                    </button>
                  </div>
                </div>
              ))}

              {/* Locked Progress Reward Item (matches Screenshot 1) */}
              <div className="line-reward-item">
                <div className="line-reward-thumb-wrap">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/loyalty/reward-bowl.png"
                    alt={config.rewardTitle}
                    className="line-reward-thumb"
                  />
                  <span className="line-reward-lock-badge" aria-label="Locked">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2Zm-6 6.73V17a1 1 0 0 1-2 0v-1.27a2 2 0 1 1 2 0ZM10 9V7a2 2 0 1 1 4 0v2h-4Z" />
                    </svg>
                  </span>
                </div>
                <div className="line-reward-info">
                  <div className="line-reward-title">{config.rewardTitle}</div>
                  <div className="line-reward-required">
                    {stampsRemaining} more stamp(s) required
                  </div>
                </div>
              </div>
            </>
          ) : claimedCoupons.length === 0 ? (
            <div className="line-reward-empty">
              ยังไม่มีประวัติการใช้คูปองส่วนลด
            </div>
          ) : (
            claimedCoupons.map((coupon) => (
              <div key={coupon.id} className="line-reward-item claimed">
                <div className="line-reward-thumb-wrap">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/loyalty/reward-bowl.png"
                    alt={coupon.title}
                    className="line-reward-thumb grayscale"
                  />
                  <span className="line-reward-used-pill">ใช้แล้ว</span>
                </div>
                <div className="line-reward-info">
                  <div className="line-reward-title">{coupon.title}</div>
                  <div className="line-reward-code">
                    รหัส #{coupon.code} · ใช้เมื่อ {formatThaiDateTime(coupon.claimedAt)}
                  </div>
                  <button
                    type="button"
                    className="line-reward-receipt-btn"
                    onClick={() =>
                      setReceiptCoupon({
                        code: coupon.code,
                        title: coupon.title,
                        claimedAtFormatted: formatThaiDateTime(coupon.claimedAt),
                        displayName: member.displayName,
                        chatNotified: false,
                      })
                    }
                  >
                    ดูใบยืนยันคูปอง (สำหรับแคปส่งร้าน)
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* How this works Section (matches Screenshot 1) */}
        <div className="line-stamp-how">
          <h2>How this works</h2>
          <div className="line-stamp-rules">
            {rulesLines.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
          <button
            type="button"
            className="line-stamp-help-link"
            onClick={() => setShowHelpModal(true)}
          >
            See Service Guide/Help <span aria-hidden>›</span>
          </button>
        </div>

        {/* Floating Bottom "Scan QR code" Pill Button */}
        <div className="line-stamp-fab-bar">
          <button
            type="button"
            className="line-stamp-scan-btn"
            onClick={handleScanButtonClick}
            disabled={loading || claiming}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7V5a2 2 0 0 1 2-2h2" />
              <path d="M17 3h2a2 2 0 0 1 2 2v2" />
              <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
              <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Scan QR code</span>
          </button>
        </div>
      </div>

      {/* Modal 1: Confirm Self-Service Coupon Redemption (ลูกค้ากดตัดแต้มเอง) */}
      {confirmRedeemCoupon && (
        <div className="line-modal-backdrop" onClick={() => !redeemingCouponId && setConfirmRedeemCoupon(null)}>
          <div className="line-modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="line-modal-badge">🎟️ ยืนยันการใช้คูปองส่วนลด</div>
            <h3>{confirmRedeemCoupon.title}</h3>
            <p className="line-modal-desc">
              เมื่อกดปุ่ม <strong>“ยืนยันใช้สิทธิ์ส่วนลดตอนนี้”</strong> ระบบจะตัดสิทธิ์คูปองใบนี้ไปยังหน้า Claimed rewards พร้อมแสดงหน้าจอยืนยันและส่งแจ้งเตือนเข้าแชท LINE ร้าน เพื่อให้คุณแคปหน้าจอส่งให้ทางร้านได้ทันที
            </p>
            <div className="line-modal-code-box">
              <span>รหัสคูปอง</span>
              <strong>#{confirmRedeemCoupon.code}</strong>
            </div>
            <div className="line-modal-actions">
              <button
                type="button"
                className="line-modal-primary-btn"
                disabled={Boolean(redeemingCouponId)}
                onClick={handleConfirmRedeem}
              >
                {redeemingCouponId ? "กำลังตัดสิทธิ์คูปอง..." : "✓ ยืนยันใช้สิทธิ์ส่วนลดตอนนี้"}
              </button>
              <button
                type="button"
                className="line-modal-secondary-btn"
                disabled={Boolean(redeemingCouponId)}
                onClick={() => setConfirmRedeemCoupon(null)}
              >
                ยกเลิก (เก็บไว้ใช้ครั้งถัดไป)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: Screenshot-Ready Redemption Receipt (แคปหน้าจอส่งในแชทร้าน) */}
      {receiptCoupon && (
        <div className="line-modal-backdrop" onClick={() => setReceiptCoupon(null)}>
          <div className="line-modal-sheet receipt" onClick={(e) => e.stopPropagation()}>
            <div className="line-receipt-header">
              <div className="line-receipt-check">✓</div>
              <span className="line-receipt-status">ตัดสิทธิ์คูปองสำเร็จ (CLAIM CONFIRMED)</span>
              <h3>{config.cardTitle}</h3>
            </div>

            <div className="line-receipt-ticket">
              <div className="line-receipt-reward-title">{receiptCoupon.title}</div>
              <div className="line-receipt-row">
                <span>รหัสอ้างอิง</span>
                <strong>#{receiptCoupon.code}</strong>
              </div>
              <div className="line-receipt-row">
                <span>ลูกค้า</span>
                <strong>{receiptCoupon.displayName}</strong>
              </div>
              <div className="line-receipt-row">
                <span>เวลาที่กดใช้สิทธิ์</span>
                <strong>{receiptCoupon.claimedAtFormatted}</strong>
              </div>
              <div className="line-receipt-live-clock">
                <span>เวลาปัจจุบัน: {liveClock}</span>
              </div>
            </div>

            <p className="line-receipt-instruction">
              📸 <strong>แคปหน้าจอนี้ส่งในแชท LINE ร้านได้เลย!</strong>
              {receiptCoupon.chatNotified ? " (ระบบได้ส่งข้อความแจ้งเตือนเข้าแชทร้านให้อัตโนมัติแล้วเช่นกัน)" : ""}
            </p>

            <button
              type="button"
              className="line-modal-primary-btn"
              onClick={() => setReceiptCoupon(null)}
            >
              ปิดหน้าต่างนี้
            </button>
          </div>
        </div>
      )}

      {/* Modal 3: QR Scanner / Code Input Fallback */}
      {showScannerModal && (
        <div className="line-modal-backdrop" onClick={() => setShowScannerModal(false)}>
          <div className="line-modal-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>สแกนคิวอาร์โค้ดสะสมแต้ม</h3>
            <p className="line-modal-desc">
              คุณสามารถใช้กล้องในแอป LINE สแกนรูปคิวอาร์โค้ดที่ร้านส่งให้ในแชทได้โดยตรง หรือวางลิงก์คิวอาร์โค้ดด้านล่างเพื่อรับแต้มทันที
            </p>
            <input
              type="text"
              className="line-modal-input"
              placeholder="วางลิงก์ QR Code หรือรหัสจากร้าน..."
              value={manualQrInput}
              onChange={(e) => setManualQrInput(e.target.value)}
            />
            <div className="line-modal-actions">
              <button
                type="button"
                className="line-modal-primary-btn"
                onClick={() => handleScannedQrText(manualQrInput)}
                disabled={!manualQrInput.trim()}
              >
                รับแต้มสะสม
              </button>
              <button
                type="button"
                className="line-modal-secondary-btn"
                onClick={() => setShowScannerModal(false)}
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 4: Customer Display Name Editor (when testing outside LINE) */}
      {showNameModal && (
        <div className="line-modal-backdrop" onClick={() => setShowNameModal(false)}>
          <div className="line-modal-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>ระบุชื่อของคุณบนบัตรสะสมแต้ม</h3>
            <p className="line-modal-desc">
              ชื่อนี้จะแสดงในใบยืนยันคูปองส่วนลดและในระบบของทางร้าน (หากเปิดผ่านแอป LINE ระบบจะดึงชื่อ LINE ของคุณให้อัตโนมัติ)
            </p>
            <input
              type="text"
              className="line-modal-input"
              placeholder="เช่น คุณนนท์, ลูกค้าประจำ..."
              value={nameDraft}
              maxLength={60}
              onChange={(e) => setNameDraft(e.target.value)}
            />
            <div className="line-modal-actions">
              <button
                type="button"
                className="line-modal-primary-btn"
                onClick={handleSaveCustomDisplayName}
                disabled={!nameDraft.trim()}
              >
                บันทึกชื่อ
              </button>
              <button
                type="button"
                className="line-modal-secondary-btn"
                onClick={() => setShowNameModal(false)}
              >
                ยกเลิก
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 5: Service Guide / Help */}
      {showHelpModal && (
        <div className="line-modal-backdrop" onClick={() => setShowHelpModal(false)}>
          <div className="line-modal-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>วิธีใช้งานบัตรสะสมแต้ม {config.cardTitle}</h3>
            <div className="line-modal-desc" style={{ textAlign: "left" }}>
              <p><strong>1. การสะสมแต้ม:</strong> เมื่อสั่งซื้อเมนูหลัก ทางร้านจะส่งรูป QR Code ตามจำนวนกล่อง (1–10 กล่อง) ให้ในแชท เมื่อสแกนแล้วแต้มจะขึ้นบนบัตรทันทีพร้อมแจ้งเตือนในแชท</p>
              <p style={{ marginTop: 8 }}><strong>2. การใช้ส่วนลด 50%:</strong> เมื่อสะสมครบ {config.stampsPerReward} แต้ม ระบบจะออกคูปองไว้ในแถบ <strong>Unclaimed rewards</strong> คุณสามารถกดปุ่มใช้คูปองและแคปหน้าจอยืนยันส่งให้ร้านในแชทได้เลย</p>
              <p style={{ marginTop: 8 }}><strong>3. อายุแต้มสะสม:</strong> แต้มมีอายุ {config.validityMonths} เดือนนับจากวันที่สะสมแต้มครั้งล่าสุด</p>
            </div>
            <button
              type="button"
              className="line-modal-primary-btn"
              onClick={() => setShowHelpModal(false)}
            >
              เข้าใจแล้ว
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
