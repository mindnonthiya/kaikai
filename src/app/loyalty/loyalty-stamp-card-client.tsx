"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_LOYALTY_CARD_TITLE,
  DEFAULT_LOYALTY_RULES_TEXT,
  type LoyaltyConfig,
  type LoyaltyCouponRecord,
  formatThaiDateTime,
  formatValidTillDate,
  parseLoyaltyQueryParams,
  stripEmoji,
} from "@/lib/loyalty";

const LOCAL_USER_ID_KEY = "kaikai_loyalty_line_uid_v1";
const LOCAL_DISPLAY_NAME_KEY = "kaikai_loyalty_display_name_v1";
const LOCAL_LINE_PROFILE_KEY = "kaikai_loyalty_line_prof_v1";
const LOCAL_CONFIG_PREFIX = "kaikai_loyalty_cfg_";

export interface InitialLoyaltyCardConfig {
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

interface LiffDecodedIdToken {
  sub?: string;
  name?: string;
  picture?: string;
}

interface LiffWindowObject {
  init: (config: { liffId: string }) => Promise<void>;
  isLoggedIn: () => boolean;
  isInClient: () => boolean;
  login: (config?: { redirectUri?: string }) => void;
  getAccessToken?: () => string | null;
  getDecodedIDToken?: () => LiffDecodedIdToken | null;
  getProfile: () => Promise<{
    userId: string;
    displayName: string;
    pictureUrl?: string;
  }>;
  scanCodeV2?: () => Promise<{ value: string | null }>;
}

declare global {
  interface Window {
    liff?: LiffWindowObject;
  }
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

type CardConfigState = InitialLoyaltyCardConfig;

interface ClaimNotificationBanner {
  type: "success" | "warning" | "error";
  title: string;
  subtitle: string;
  pointsAdded?: number;
  rewardsUnlocked?: number;
  chatNotified?: boolean;
  pushReason?: string;
}

interface RedeemedReceiptModalState {
  code: string;
  title: string;
  claimedAtFormatted: string;
  displayName: string;
  pictureUrl: string | null;
  chatNotified: boolean;
  isFreshRedemption: boolean;
}

function getOrCreateBrowserUserId(): string {
  if (typeof window === "undefined") return "guest";
  try {
    const existing = window.localStorage.getItem(LOCAL_USER_ID_KEY);
    if (existing && existing.trim().length >= 6) return existing.trim();
    const randomPart = Array.from(window.crypto.getRandomValues(new Uint8Array(8)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const created = `web_${randomPart}`;
    window.localStorage.setItem(LOCAL_USER_ID_KEY, created);
    return created;
  } catch {
    return "web_fallback_guest";
  }
}

function getSavedDisplayName(): string {
  if (typeof window === "undefined") return "ลูกค้า LINE";
  try {
    const saved = window.localStorage.getItem(LOCAL_DISPLAY_NAME_KEY);
    return saved && saved.trim() ? saved.trim() : "ลูกค้า LINE";
  } catch {
    return "ลูกค้า LINE";
  }
}

function getCachedLineProfile(): { userId: string; displayName: string; pictureUrl: string | null } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LOCAL_LINE_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId?: string; displayName?: string; pictureUrl?: string | null };
    if (parsed && typeof parsed.userId === "string" && parsed.userId.startsWith("U")) {
      return {
        userId: parsed.userId,
        displayName: parsed.displayName || "ลูกค้า LINE",
        pictureUrl: parsed.pictureUrl ?? null,
      };
    }
  } catch {
    // Ignore storage error
  }
  return null;
}

function saveCachedLineProfile(profile: { userId: string; displayName: string; pictureUrl: string | null }): void {
  if (typeof window === "undefined" || !profile.userId.startsWith("U")) return;
  try {
    window.localStorage.setItem(LOCAL_LINE_PROFILE_KEY, JSON.stringify(profile));
    if (profile.displayName) {
      window.localStorage.setItem(LOCAL_DISPLAY_NAME_KEY, profile.displayName);
    }
  } catch {
    // Ignore storage error
  }
}

function getCachedShopConfig(shopSecret: string): Omit<CardConfigState, "liffId"> | null {
  if (typeof window === "undefined" || !shopSecret) return null;
  try {
    const raw = window.localStorage.getItem(`${LOCAL_CONFIG_PREFIX}${shopSecret}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { cfg?: Omit<CardConfigState, "liffId">; ts?: number };
    // Keep client display config cache short (2 minutes) and never cache liffId
    if (parsed?.cfg && Date.now() - Number(parsed.ts ?? 0) < 2 * 60 * 1000) {
      return parsed.cfg;
    }
  } catch {
    // Ignore storage error
  }
  return null;
}

function saveCachedShopConfig(shopSecret: string, cfg: CardConfigState): void {
  if (typeof window === "undefined" || !shopSecret) return;
  try {
    const { liffId: _omittedLiffId, ...displayCfg } = cfg;
    void _omittedLiffId;
    window.localStorage.setItem(
      `${LOCAL_CONFIG_PREFIX}${shopSecret}`,
      JSON.stringify({ cfg: displayCfg, ts: Date.now() }),
    );
  } catch {
    // Ignore storage error
  }
}

function isRecentlyClaimedWithinFiveMinutes(claimedAt: string | null | undefined): boolean {
  if (!claimedAt) return false;
  const ts = new Date(claimedAt).getTime();
  if (!Number.isFinite(ts)) return false;
  const diffMs = Date.now() - ts;
  return diffMs >= -60_000 && diffMs <= 5 * 60 * 1000;
}

function attemptLoadLiffScriptOnce(timeoutMs = 4000): Promise<LiffWindowObject | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.liff) return Promise.resolve(window.liff);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: LiffWindowObject | null, scriptEl?: HTMLScriptElement | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (!val && scriptEl && scriptEl.parentNode) {
        scriptEl.parentNode.removeChild(scriptEl);
      }
      resolve(val);
    };

    const existing = document.querySelector('script[data-line-liff="1"]') as HTMLScriptElement | null;
    if (existing) {
      if (window.liff) {
        resolve(window.liff);
        return;
      }
      if (existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }

    const script = document.createElement("script");
    script.src = "https://static.line-scdn.net/liff/edge/2/sdk.js";
    script.async = true;
    script.dataset.lineLiff = "1";

    const timer = window.setTimeout(() => {
      finish(window.liff ?? null, script);
    }, timeoutMs);

    script.onload = () => finish(window.liff ?? null, script);
    script.onerror = () => finish(null, script);
    document.head.appendChild(script);
  });
}

async function loadLiffSdkScript(): Promise<LiffWindowObject | null> {
  if (typeof window === "undefined") return null;
  if (window.liff) return window.liff;

  const firstTry = await attemptLoadLiffScriptOnce(4000);
  if (firstTry) return firstTry;

  await new Promise((r) => setTimeout(r, 300));
  return attemptLoadLiffScriptOnce(4000);
}

function getActiveLiffAccessToken(): string {
  if (typeof window === "undefined" || !window.liff) return "";
  try {
    if (window.liff.isLoggedIn() && typeof window.liff.getAccessToken === "function") {
      return window.liff.getAccessToken() ?? "";
    }
  } catch {
    // Ignore LIFF token error
  }
  return "";
}

function CustomerLineAvatar({
  pictureUrl,
  displayName,
  size = 28,
}: {
  pictureUrl: string | null;
  displayName: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const clean = (displayName || "ลูกค้า LINE").trim();
  const initial = Array.from(clean)[0] ?? "ล";
  const showImg = Boolean(pictureUrl && !broken);

  return (
    <span
      className="line-customer-avatar"
      style={{ width: size, height: size }}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={pictureUrl!}
          alt={clean}
          className="line-customer-avatar-img"
          onError={() => setBroken(true)}
        />
      ) : (
        <span
          className="line-customer-avatar-fallback"
          style={{ fontSize: Math.max(11, Math.round(size * 0.44)) }}
        >
          {initial}
        </span>
      )}
    </span>
  );
}

export function LoyaltyStampCardClient({
  initialShopSecret,
  initialPoints,
  initialToken,
  initialLiffId,
  initialConfig,
}: {
  initialShopSecret: string;
  initialPoints: number | null;
  initialToken: string;
  initialLiffId: string;
  initialConfig?: InitialLoyaltyCardConfig | Partial<LoyaltyConfig> | null;
}) {
  const [shopSecret, setShopSecret] = useState(initialShopSecret);
  const [config, setConfig] = useState<CardConfigState>({
    cardTitle: stripEmoji(initialConfig?.cardTitle ?? DEFAULT_LOYALTY_CARD_TITLE) || DEFAULT_LOYALTY_CARD_TITLE,
    cardHeadline: stripEmoji(initialConfig?.cardHeadline ?? "สะสม 10 กล่อง ลด 50%") || "สะสม 10 กล่อง ลด 50%",
    rewardTitle: stripEmoji(initialConfig?.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง") || "ลด 50% เมนูหลัก 1 กล่อง",
    stampsPerReward: initialConfig?.stampsPerReward ?? 10,
    validityMonths: initialConfig?.validityMonths ?? 3,
    cooldownMinutes: initialConfig?.cooldownMinutes ?? 5,
    rulesText: initialConfig?.rulesText ?? DEFAULT_LOYALTY_RULES_TEXT,
    liffId: initialLiffId || initialConfig?.liffId || "",
    botBasicId: initialConfig?.botBasicId ?? "",
  });

  const [member, setMember] = useState<MemberState>(() => {
    const defaultExp = new Date();
    defaultExp.setMonth(defaultExp.getMonth() + 3);
    return {
      lineUserId: "",
      displayName: "ลูกค้า LINE",
      pictureUrl: null,
      stamps: 0,
      lifetimeStamps: 0,
      expiresAt: defaultExp.toISOString(),
      validTillFormatted: formatValidTillDate(defaultExp),
      lastStampedAt: null,
      expiredReset: false,
    };
  });

  const [coupons, setCoupons] = useState<LoyaltyCouponRecord[]>([]);
  const [activeTab, setActiveTab] = useState<"unclaimed" | "claimed">("unclaimed");
  const [gridExpanded, setGridExpanded] = useState(true);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [memberLoaded, setMemberLoaded] = useState(false);
  const [lineAuthError, setLineAuthError] = useState<string | null>(null);
  const [redeemingCouponId, setRedeemingCouponId] = useState<string | null>(null);
  const [claimBanner, setClaimBanner] = useState<ClaimNotificationBanner | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Modals
  const [showScannerModal, setShowScannerModal] = useState(false);
  const [showManualQrInput, setShowManualQrInput] = useState(false);
  const [manualQrInput, setManualQrInput] = useState("");
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showNameModal, setShowNameModal] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmRedeemCoupon, setConfirmRedeemCoupon] = useState<LoyaltyCouponRecord | null>(null);
  const [copiedCouponCode, setCopiedCouponCode] = useState(false);
  const [receiptCoupon, setReceiptCoupon] = useState<RedeemedReceiptModalState | null>(null);
  const [isInLineClient, setIsInLineClient] = useState(false);

  const hasProcessedInitialQr = useRef(false);
  const rewardsSectionRef = useRef<HTMLDivElement | null>(null);

  const fetchCardState = useCallback(
    async (
      targetShopSecret: string,
      userProfile: { userId: string; displayName: string; pictureUrl: string | null },
      explicitLiffAccessToken?: string,
      configOnly = false,
    ): Promise<{ config: CardConfigState; member: MemberState | null; coupons: LoyaltyCouponRecord[] } | null> => {
      if (!targetShopSecret) {
        setErrorMessage("ไม่พบรหัสร้านค้าในลิงก์ กรุณาขอลิงก์บัตรสะสมแต้มจากทางร้าน");
        setLoading(false);
        return null;
      }

      const liffAccessToken = explicitLiffAccessToken ?? getActiveLiffAccessToken();
      const response = await fetch("/api/loyalty/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopSecret: targetShopSecret,
          configOnly,
          liffAccessToken,
          lineUserId: configOnly ? "" : userProfile.userId,
          displayName: userProfile.displayName,
          pictureUrl: userProfile.pictureUrl,
        }),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!data.ok) {
        if (data.config && typeof data.config === "object") {
          const cfg = data.config as Record<string, unknown>;
          setConfig((prev) => ({
            ...prev,
            cardTitle: String(cfg.cardTitle ?? prev.cardTitle),
            cardHeadline: String(cfg.cardHeadline ?? prev.cardHeadline),
            rewardTitle: String(cfg.rewardTitle ?? prev.rewardTitle),
            stampsPerReward: Math.max(1, Number(cfg.stampsPerReward ?? prev.stampsPerReward)),
            validityMonths: Math.max(1, Number(cfg.validityMonths ?? prev.validityMonths)),
            cooldownMinutes: Math.max(0, Number(cfg.cooldownMinutes ?? prev.cooldownMinutes)),
            rulesText: String(cfg.rulesText ?? prev.rulesText),
            liffId: String(cfg.liffId ?? prev.liffId),
            botBasicId: String(cfg.botBasicId ?? prev.botBasicId),
          }));
        }
        if (data.code === "LINE_AUTH_REQUIRED" || data.code === "LINE_AUTH_FAILED") {
          setLineAuthError(String(data.message ?? "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาลองใหม่"));
          setMemberLoaded(false);
          return null;
        }
        setErrorMessage(String(data.message ?? "ไม่สามารถโหลดข้อมูลบัตรสะสมแต้มได้"));
        return null;
      }

      const cfg = (data.config ?? {}) as Record<string, unknown>;
      const nextConfig: CardConfigState = {
        cardTitle: stripEmoji(String(cfg.cardTitle ?? DEFAULT_LOYALTY_CARD_TITLE)) || DEFAULT_LOYALTY_CARD_TITLE,
        cardHeadline: stripEmoji(String(cfg.cardHeadline ?? "สะสม 10 กล่อง ลด 50%")) || "สะสม 10 กล่อง ลด 50%",
        rewardTitle: stripEmoji(String(cfg.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง")) || "ลด 50% เมนูหลัก 1 กล่อง",
        stampsPerReward: Math.max(1, Number(cfg.stampsPerReward ?? 10)),
        validityMonths: Math.max(1, Number(cfg.validityMonths ?? 3)),
        cooldownMinutes: Math.max(0, Number(cfg.cooldownMinutes ?? 5)),
        rulesText: stripEmoji(String(cfg.rulesText ?? DEFAULT_LOYALTY_RULES_TEXT)) || DEFAULT_LOYALTY_RULES_TEXT,
        liffId: String(cfg.liffId ?? initialLiffId ?? ""),
        botBasicId: String(cfg.botBasicId ?? ""),
      };
      setConfig(nextConfig);
      saveCachedShopConfig(targetShopSecret, nextConfig);

      if (configOnly || !data.member || typeof data.member !== "object") {
        return { config: nextConfig, member: null, coupons: [] };
      }

      const mem = data.member as Record<string, unknown>;
      const rawCoupons = Array.isArray(data.coupons) ? (data.coupons as Array<Record<string, unknown>>) : [];

      const nextMember: MemberState = {
        lineUserId: String(mem.lineUserId ?? userProfile.userId),
        displayName: String(mem.displayName ?? userProfile.displayName),
        pictureUrl: mem.pictureUrl ? String(mem.pictureUrl) : userProfile.pictureUrl,
        stamps: Math.max(0, Number(mem.stamps ?? 0)),
        lifetimeStamps: Math.max(0, Number(mem.lifetimeStamps ?? 0)),
        expiresAt: mem.expiresAt ? String(mem.expiresAt) : null,
        validTillFormatted: String(
          mem.validTillFormatted ?? formatValidTillDate(mem.expiresAt ? String(mem.expiresAt) : null),
        ),
        lastStampedAt: mem.lastStampedAt ? String(mem.lastStampedAt) : null,
        expiredReset: Boolean(mem.expiredReset),
      };
      setMember(nextMember);
      setMemberLoaded(true);
      setLineAuthError(null);
      saveCachedLineProfile({
        userId: nextMember.lineUserId,
        displayName: nextMember.displayName,
        pictureUrl: nextMember.pictureUrl,
      });

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
    ) => {
      setClaiming(true);
      try {
        const liffAccessToken = getActiveLiffAccessToken();
        const response = await fetch("/api/loyalty/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shopSecret: targetShopSecret,
            points,
            token,
            liffAccessToken,
            lineUserId: userProfile.userId,
            displayName: userProfile.displayName,
            pictureUrl: userProfile.pictureUrl,
          }),
        });
        const data = (await response.json()) as Record<string, unknown>;

        if (!data.ok) {
          if (data.code === "LINE_AUTH_REQUIRED" || data.code === "LINE_AUTH_FAILED") {
            setLineAuthError(String(data.message ?? "เชื่อมต่อ LINE ไม่สำเร็จ กรุณาลองใหม่"));
            setMemberLoaded(false);
            return;
          }
          setClaimBanner({
            type: data.code === "COOLDOWN_ACTIVE" ? "warning" : "error",
            title: data.code === "COOLDOWN_ACTIVE" ? "สแกนซ้ำเร็วเกินไป" : "ไม่สามารถสะสมแต้มได้",
            subtitle: String(data.message ?? "คิวอาร์โค้ดไม่ถูกต้องหรือหมดอายุ"),
          });
          await fetchCardState(targetShopSecret, userProfile, liffAccessToken);
          return;
        }

        if (data.config && typeof data.config === "object") {
          const cfg = data.config as Record<string, unknown>;
          setConfig((prev) => {
            const nextCfg: CardConfigState = {
              cardTitle: stripEmoji(String(cfg.cardTitle ?? prev.cardTitle)) || prev.cardTitle,
              cardHeadline: stripEmoji(String(cfg.cardHeadline ?? prev.cardHeadline)) || prev.cardHeadline,
              rewardTitle: stripEmoji(String(cfg.rewardTitle ?? prev.rewardTitle)) || prev.rewardTitle,
              stampsPerReward: Math.max(1, Number(cfg.stampsPerReward ?? prev.stampsPerReward)),
              validityMonths: Math.max(1, Number(cfg.validityMonths ?? prev.validityMonths)),
              cooldownMinutes: Math.max(0, Number(cfg.cooldownMinutes ?? prev.cooldownMinutes)),
              rulesText: String(cfg.rulesText ?? prev.rulesText),
              liffId: String(cfg.liffId ?? prev.liffId),
              botBasicId: String(cfg.botBasicId ?? prev.botBasicId),
            };
            saveCachedShopConfig(targetShopSecret, nextCfg);
            return nextCfg;
          });
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
          title: `สะสมเพิ่ม +${pointsAdded} แต้มสำเร็จ (รวม ${newStamps}/${stampsPerReward} แต้ม)`,
          subtitle:
            rewardsUnlocked > 0
              ? `ได้รับคูปองส่วนลดใหม่ +${rewardsUnlocked} ใบ พร้อมใช้ด้านล่าง`
              : "",
          pointsAdded,
          rewardsUnlocked,
          chatNotified,
          pushReason: notification?.pushReason,
        });

        if (data.member && typeof data.member === "object" && Array.isArray(data.coupons)) {
          const mem = data.member as Record<string, unknown>;
          const rawCoupons = data.coupons as Array<Record<string, unknown>>;
          const nextLineUserId = String(mem.lineUserId ?? userProfile.userId);
          const nextDisplayName = String(mem.displayName ?? userProfile.displayName);
          const nextPictureUrl = mem.pictureUrl
            ? String(mem.pictureUrl)
            : (userProfile.pictureUrl ?? null);

          setMember((prev) => ({
            lineUserId: nextLineUserId || prev.lineUserId,
            displayName: nextDisplayName || prev.displayName,
            pictureUrl: nextPictureUrl ?? prev.pictureUrl,
            stamps: Math.max(0, Number(mem.stamps ?? newStamps)),
            lifetimeStamps: Math.max(0, Number(mem.lifetimeStamps ?? prev.lifetimeStamps)),
            expiresAt: mem.expiresAt ? String(mem.expiresAt) : prev.expiresAt,
            validTillFormatted: String(
              mem.validTillFormatted ??
                data.validTillFormatted ??
                formatValidTillDate(mem.expiresAt ? String(mem.expiresAt) : null),
            ),
            lastStampedAt: mem.lastStampedAt ? String(mem.lastStampedAt) : prev.lastStampedAt,
            expiredReset: Boolean(mem.expiredReset),
          }));
          setMemberLoaded(true);
          setLineAuthError(null);
          saveCachedLineProfile({
            userId: nextLineUserId,
            displayName: nextDisplayName,
            pictureUrl: nextPictureUrl,
          });
          setCoupons(
            rawCoupons.map((c) => ({
              id: String(c.id),
              code: String(c.code ?? ""),
              title: String(c.title ?? config.rewardTitle),
              status: c.status === "claimed" ? "claimed" : "unclaimed",
              issuedAt: String(c.issuedAt ?? new Date().toISOString()),
              claimedAt: c.claimedAt ? String(c.claimedAt) : null,
            })),
          );
        } else {
          await fetchCardState(targetShopSecret, userProfile, liffAccessToken);
        }

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
    [config.rewardTitle, fetchCardState],
  );

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

      if (typeof window !== "undefined") {
        try {
          if (resolvedShopSecret && resolvedPoints && resolvedToken) {
            window.sessionStorage.setItem(
              "kaikai_pending_qr_claim_v1",
              JSON.stringify({
                shopSecret: resolvedShopSecret,
                points: resolvedPoints,
                token: resolvedToken,
                ts: Date.now(),
              }),
            );
          } else {
            const rawSaved = window.sessionStorage.getItem("kaikai_pending_qr_claim_v1");
            if (rawSaved) {
              const saved = JSON.parse(rawSaved) as {
                shopSecret?: string;
                points?: number;
                token?: string;
                ts?: number;
              };
              if (saved && Date.now() - Number(saved.ts ?? 0) < 5 * 60 * 1000) {
                resolvedShopSecret = resolvedShopSecret || saved.shopSecret || "";
                resolvedPoints = resolvedPoints ?? saved.points ?? null;
                resolvedToken = resolvedToken || saved.token || "";
              } else {
                window.sessionStorage.removeItem("kaikai_pending_qr_claim_v1");
              }
            }
          }
        } catch {
          // Ignore sessionStorage error
        }
      }

      if (resolvedShopSecret) {
        setShopSecret(resolvedShopSecret);
      }

      const fallbackId = getOrCreateBrowserUserId();
      const fallbackName = getSavedDisplayName();
      const cachedLineProf = getCachedLineProfile();
      let userProfile = cachedLineProf ?? {
        userId: fallbackId,
        displayName: fallbackName,
        pictureUrl: null as string | null,
      };

      const hasPendingQrClaim = Boolean(
        !hasProcessedInitialQr.current && resolvedPoints && resolvedToken,
      );

      let effectiveLiffId = initialLiffId || initialConfig?.liffId || "";
      if (!initialConfig && resolvedShopSecret) {
        const cachedCfg = getCachedShopConfig(resolvedShopSecret);
        if (cachedCfg) {
          setConfig((prev) => ({ ...prev, ...cachedCfg }));
        }
      }
      if (!effectiveLiffId && resolvedShopSecret) {
        const configState = await fetchCardState(
          resolvedShopSecret,
          userProfile,
          undefined,
          true,
        );
        if (cancelled) return;
        effectiveLiffId = effectiveLiffId || configState?.config.liffId || "";
      }

      if (effectiveLiffId) {
        const liff = await loadLiffSdkScript();
        if (cancelled) return;
        if (!liff) {
          setLineAuthError("เชื่อมต่อ LINE ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
          setLoading(false);
          return;
        }
        try {
          await Promise.race([
            liff.init({ liffId: effectiveLiffId }),
            new Promise<never>((_, reject) =>
              window.setTimeout(() => reject(new Error("LIFF_INIT_TIMEOUT")), 5000),
            ),
          ]);
          const inClient = liff.isInClient();
          setIsInLineClient(inClient);

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
            const decoded =
              typeof liff.getDecodedIDToken === "function" ? liff.getDecodedIDToken() : null;

            if (decoded?.sub && decoded.sub.startsWith("U")) {
              userProfile = {
                userId: decoded.sub,
                displayName: decoded.name || userProfile.displayName || fallbackName,
                pictureUrl: decoded.picture ?? userProfile.pictureUrl ?? null,
              };
            }

            if (userProfile.userId.startsWith("U")) {
              setMember((prev) => ({
                ...prev,
                lineUserId: userProfile.userId,
                displayName: userProfile.displayName || prev.displayName,
                pictureUrl: userProfile.pictureUrl ?? prev.pictureUrl,
              }));
              saveCachedLineProfile(userProfile);
            }

            // Refresh latest LINE profile in the background without blocking QR stamp claim
            const profileRefreshPromise = liff
              .getProfile()
              .then((profile) => {
                if (cancelled) return null;
                const freshProfile = {
                  userId: profile.userId,
                  displayName: profile.displayName || fallbackName,
                  pictureUrl: profile.pictureUrl ?? null,
                };
                userProfile = freshProfile;
                setMember((prev) => ({
                  ...prev,
                  lineUserId: freshProfile.userId,
                  displayName: freshProfile.displayName || prev.displayName,
                  pictureUrl: freshProfile.pictureUrl ?? prev.pictureUrl,
                }));
                saveCachedLineProfile(freshProfile);
                return freshProfile;
              })
              .catch(() => null);

            if (!hasPendingQrClaim) {
              if (userProfile.userId.startsWith("U")) {
                await fetchCardState(resolvedShopSecret, userProfile);
              } else {
                const freshProfile = await profileRefreshPromise;
                if (cancelled) return;
                await fetchCardState(resolvedShopSecret, freshProfile ?? userProfile);
              }
            }
          } else {
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
          setLineAuthError("เชื่อมต่อ LINE ไม่สำเร็จ กรุณาเปิดบัตรสะสมแต้มผ่านแอป LINE แล้วลองใหม่");
          setMemberLoaded(false);
          setLoading(false);
          return;
        }
      } else if (!hasPendingQrClaim) {
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
        await executeStampClaim(resolvedShopSecret, resolvedPoints, resolvedToken, userProfile);
      }

      if (!cancelled) {
        setLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [executeStampClaim, fetchCardState, initialConfig, initialLiffId, initialPoints, initialShopSecret, initialToken]);

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
    setShowManualQrInput(false);
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
      const liffAccessToken = getActiveLiffAccessToken();
      const response = await fetch("/api/loyalty/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopSecret,
          couponId: coupon.id,
          liffAccessToken,
          lineUserId: member.lineUserId || getOrCreateBrowserUserId(),
          displayName: member.displayName || getSavedDisplayName(),
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

      if (Array.isArray(data.coupons)) {
        const rawCoupons = data.coupons as Array<Record<string, unknown>>;
        setCoupons(
          rawCoupons.map((c) => ({
            id: String(c.id),
            code: String(c.code ?? ""),
            title: String(c.title ?? config.rewardTitle),
            status: c.status === "claimed" ? "claimed" : "unclaimed",
            issuedAt: String(c.issuedAt ?? new Date().toISOString()),
            claimedAt: c.claimedAt ? String(c.claimedAt) : null,
          })),
        );
      } else {
        await fetchCardState(
          shopSecret,
          {
            userId: member.lineUserId || getOrCreateBrowserUserId(),
            displayName: member.displayName || getSavedDisplayName(),
            pictureUrl: member.pictureUrl,
          },
          liffAccessToken,
        );
      }

      setConfirmRedeemCoupon(null);
      setActiveTab("claimed");
      setReceiptCoupon({
        code: String(data.code ?? coupon.code),
        title: String(data.title ?? coupon.title),
        claimedAtFormatted: String(data.claimedAtFormatted ?? formatThaiDateTime(new Date())),
        displayName: String(data.displayName ?? member.displayName),
        pictureUrl: member.pictureUrl,
        chatNotified,
        isFreshRedemption: !data.alreadyClaimed,
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

  const handleCopyCouponCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(`#${code}`);
      setCopiedCouponCode(true);
      setTimeout(() => setCopiedCouponCode(false), 2000);
    } catch {
      // Ignore
    }
  };

  const totalSlots = Math.max(1, Math.min(30, config.stampsPerReward));
  const isLineConnected = Boolean(member.lineUserId.startsWith("U") || isInLineClient);
  const cleanCardTitle = stripEmoji(config.cardTitle) || DEFAULT_LOYALTY_CARD_TITLE;
  const cleanCardHeadline = stripEmoji(config.cardHeadline) || "สะสม 10 กล่อง ลด 50%";
  const cleanRewardTitle = stripEmoji(config.rewardTitle) || "ลด 50% เมนูหลัก 1 กล่อง";
  const cleanMemberName = stripEmoji(member.displayName) || "ลูกค้า LINE";

  return (
    <div className="line-stamp-shell">
      <div className="line-stamp-container">
        {/* TOP NOTIFICATION BANNER */}
        {claiming && (
          <div className="line-stamp-top-banner info">
            <strong>กำลังบันทึกแต้มสะสม...</strong>
          </div>
        )}

        {claimBanner && !claiming && (
          <div className={`line-stamp-top-banner ${claimBanner.type}`}>
            <div className="line-stamp-alert-head">
              <strong>{stripEmoji(claimBanner.title)}</strong>
              <button
                type="button"
                className="line-stamp-alert-close"
                onClick={() => setClaimBanner(null)}
                aria-label="ปิดแจ้งเตือน"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            {claimBanner.subtitle && <p>{stripEmoji(claimBanner.subtitle)}</p>}
          </div>
        )}

        {errorMessage && (
          <div className="line-stamp-top-banner error">
            <strong>แจ้งเตือนระบบ</strong>
            <p>{stripEmoji(errorMessage)}</p>
          </div>
        )}

        {/* Compact Mascot Banner */}
        <div className="line-stamp-hero">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/loyalty/banner-chicken.jpg"
            alt={cleanCardTitle}
            className="line-stamp-hero-img"
          />
        </div>

        {/* Rich Menu Themed Stamp Card */}
        <div className="line-stamp-card-wrap">
          <div className="line-stamp-card">
            {/* Overlapping Circular Bowl Avatar */}
            <div className="line-stamp-avatar-ring">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/loyalty/avatar-bowl.png"
                alt={cleanCardTitle}
                className="line-stamp-avatar-img"
              />
            </div>

            <h1 className="line-stamp-title">{cleanCardTitle}</h1>

            <div className="line-stamp-headline-pill">{cleanCardHeadline}</div>

            {/* Customer LINE Profile & Validity Bar */}
            {(memberLoaded || member.lineUserId) && (
              <div className="line-stamp-user-bar">
                <CustomerLineAvatar
                  pictureUrl={member.pictureUrl}
                  displayName={cleanMemberName}
                  size={26}
                />
                <span className="line-stamp-user-name">{cleanMemberName}</span>
                {isLineConnected && (
                  <span className="line-stamp-line-pill">LINE</span>
                )}
                <span className="line-stamp-valid-inline">
                  {memberLoaded ? `ใช้ได้ถึง ${member.validTillFormatted}` : "สมาชิก"}
                </span>
                {!isLineConnected && !config.liffId && (
                  <button
                    type="button"
                    className="line-stamp-edit-name-btn"
                    onClick={() => {
                      setNameDraft(cleanMemberName === "ลูกค้า LINE" ? "" : cleanMemberName);
                      setShowNameModal(true);
                    }}
                  >
                    แก้ไขชื่อ
                  </button>
                )}
              </div>
            )}

            {lineAuthError ? (
              <div className="line-stamp-auth-box">
                <strong>{stripEmoji(lineAuthError)}</strong>
                <p>กรุณาเข้าสู่ระบบด้วยบัญชี LINE เพื่อดูแต้มสะสมของคุณ</p>
                <button
                  type="button"
                  className="line-stamp-auth-btn"
                  onClick={() => {
                    if (config.liffId) {
                      window.location.href = `https://liff.line.me/${config.liffId}?s=${encodeURIComponent(shopSecret)}`;
                    } else {
                      window.location.reload();
                    }
                  }}
                >
                  เข้าสู่ระบบด้วย LINE
                </button>
              </div>
            ) : !memberLoaded && (loading || claiming) ? (
              <div className="line-stamp-loading-box">
                กำลังโหลดข้อมูลแต้มสะสมของคุณ...
              </div>
            ) : (
              <div className="line-stamp-board">
                {/* Stamp Progress Row */}
                <button
                  type="button"
                  className="line-stamp-progress-row"
                  onClick={() => setGridExpanded((prev) => !prev)}
                  aria-expanded={gridExpanded ? "true" : "false"}
                >
                  <div className="line-stamp-progress-left">
                    <span className="line-stamp-reward-badge">แต้มสะสม</span>
                    <span className="line-stamp-progress-text">
                      <strong>{member.stamps} / {totalSlots}</strong> แต้ม
                    </span>
                  </div>
                  <div className="line-stamp-progress-right">
                    <span className="line-stamp-remaining-pill">
                      {stampsRemaining > 0
                        ? `อีก ${stampsRemaining} แต้มรับสิทธิ์`
                        : "ครบรับรางวัลแล้ว"}
                    </span>
                    <span className={`line-stamp-chevron ${gridExpanded ? "open" : ""}`} aria-hidden>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="18 15 12 9 6 15" />
                      </svg>
                    </span>
                  </div>
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
                          aria-label={`แต้มที่ ${slotNumber} จาก ${totalSlots}${isFilled ? " (สะสมแล้ว)" : ""}`}
                        >
                          {isFilled ? (
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : isFinalSlot ? (
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 12 20 22 4 22 4 12" />
                              <rect x="2" y="7" width="20" height="5" rx="1" />
                              <line x1="12" y1="22" x2="12" y2="7" />
                              <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
                              <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
                            </svg>
                          ) : (
                            <span className="line-stamp-slot-num">{slotNumber}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Ready-to-use Coupon Highlight Callout */}
        {unclaimedCoupons.length > 0 && (
          <div className="line-ready-coupon-callout">
            <div className="line-ready-coupon-callout-info">
              <strong>มีคูปองส่วนลดพร้อมใช้ {unclaimedCoupons.length} ใบ</strong>
              <span>{cleanRewardTitle}</span>
            </div>
            <button
              type="button"
              className="line-ready-coupon-callout-btn"
              onClick={() => {
                setActiveTab("unclaimed");
                setConfirmRedeemCoupon(unclaimedCoupons[0]);
              }}
            >
              ใช้คูปอง
            </button>
          </div>
        )}

        {/* Thai Rewards Tabs: คูปองพร้อมใช้ | ประวัติการใช้สิทธิ์ */}
        <div className="line-stamp-tabs" ref={rewardsSectionRef}>
          <button
            type="button"
            className={`line-stamp-tab ${activeTab === "unclaimed" ? "active" : ""}`}
            onClick={() => setActiveTab("unclaimed")}
          >
            คูปองพร้อมใช้
            {unclaimedCoupons.length > 0 && (
              <span className="line-stamp-tab-count">{unclaimedCoupons.length}</span>
            )}
          </button>
          <button
            type="button"
            className={`line-stamp-tab ${activeTab === "claimed" ? "active" : ""}`}
            onClick={() => setActiveTab("claimed")}
          >
            ประวัติการใช้สิทธิ์
            {claimedCoupons.length > 0 && (
              <span className="line-stamp-tab-count muted">{claimedCoupons.length}</span>
            )}
          </button>
        </div>

        {/* Rewards Content */}
        <div className="line-stamp-rewards-section">
          {activeTab === "unclaimed" ? (
            <>
              {unclaimedCoupons.map((coupon) => (
                <div key={coupon.id} className="line-reward-item unlocked">
                  <div className="line-reward-thumb-wrap">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/loyalty/reward-bowl.png"
                      alt={stripEmoji(coupon.title)}
                      className="line-reward-thumb"
                    />
                    <span className="line-reward-ready-pill">พร้อมใช้</span>
                  </div>
                  <div className="line-reward-info">
                    <div className="line-reward-title">{stripEmoji(coupon.title)}</div>
                    <div className="line-reward-code">รหัส #{coupon.code}</div>
                    <button
                      type="button"
                      className="line-reward-use-btn"
                      onClick={() => {
                        setCopiedCouponCode(false);
                        setConfirmRedeemCoupon(coupon);
                      }}
                    >
                      กดใช้คูปอง
                    </button>
                  </div>
                </div>
              ))}

              {/* Next Reward Progress Item */}
              <div className="line-reward-item next-target">
                <div className="line-reward-thumb-wrap">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/loyalty/reward-bowl.png"
                    alt={cleanRewardTitle}
                    className="line-reward-thumb"
                  />
                  <span className="line-reward-lock-badge" aria-label="กำลังสะสม">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2Zm-6 6.73V17a1 1 0 0 1-2 0v-1.27a2 2 0 1 1 2 0ZM10 9V7a2 2 0 1 1 4 0v2h-4Z" />
                    </svg>
                  </span>
                </div>
                <div className="line-reward-info">
                  <div className="line-reward-title">{cleanRewardTitle}</div>
                  <div className="line-reward-required">
                    สะสมอีก {stampsRemaining} แต้ม รับคูปองใบใหม่
                  </div>
                </div>
              </div>
            </>
          ) : claimedCoupons.length === 0 ? (
            <div className="line-reward-empty">
              ยังไม่มีประวัติการใช้คูปอง
            </div>
          ) : (
            claimedCoupons.map((coupon) => (
              <div key={coupon.id} className="line-reward-item claimed">
                <div className="line-reward-thumb-wrap">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/loyalty/reward-bowl.png"
                    alt={stripEmoji(coupon.title)}
                    className="line-reward-thumb grayscale"
                  />
                  <span className="line-reward-used-pill">ใช้แล้ว</span>
                </div>
                <div className="line-reward-info">
                  <div className="line-reward-title">{stripEmoji(coupon.title)}</div>
                  <div className="line-reward-code">
                    รหัส #{coupon.code} · {formatThaiDateTime(coupon.claimedAt)}
                  </div>
                  <button
                    type="button"
                    className="line-reward-receipt-btn"
                    onClick={() =>
                      setReceiptCoupon({
                        code: coupon.code,
                        title: stripEmoji(coupon.title),
                        claimedAtFormatted: formatThaiDateTime(coupon.claimedAt),
                        displayName: cleanMemberName,
                        pictureUrl: member.pictureUrl,
                        chatNotified: false,
                        isFreshRedemption: isRecentlyClaimedWithinFiveMinutes(coupon.claimedAt),
                      })
                    }
                  >
                    {isRecentlyClaimedWithinFiveMinutes(coupon.claimedAt)
                      ? "เปิดใบยืนยันคูปอง"
                      : "ดูรายละเอียด"}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Thai Rules Section */}
        <div className="line-stamp-how">
          <h2>เงื่อนไขการสะสมแต้ม</h2>
          <div className="line-stamp-rules">
            {rulesLines.map((line, index) => (
              <p key={index}>{stripEmoji(line)}</p>
            ))}
          </div>
          <button
            type="button"
            className="line-stamp-help-link"
            onClick={() => setShowHelpModal(true)}
          >
            วิธีใช้งานบัตรสะสมแต้ม <span aria-hidden>›</span>
          </button>
        </div>

        {/* Floating Bottom "สแกน QR รับแต้ม" Button */}
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
            <span>สแกน QR รับแต้ม</span>
          </button>
        </div>
      </div>

      {/* Modal 1: Compact Coupon Confirmation */}
      {confirmRedeemCoupon && (
        <div className="line-modal-backdrop" onClick={() => !redeemingCouponId && setConfirmRedeemCoupon(null)}>
          <div className="line-modal-sheet compact" onClick={(e) => e.stopPropagation()}>
            <div className="line-modal-badge">ยืนยันใช้สิทธิ์คูปอง</div>
            <h3>{stripEmoji(confirmRedeemCoupon.title)}</h3>

            <div className="line-modal-code-box compact">
              <div className="line-modal-code-inline">
                <span className="line-modal-code-label">รหัสคูปอง</span>
                <strong>#{confirmRedeemCoupon.code}</strong>
              </div>
              <button
                type="button"
                className="line-modal-copy-btn"
                onClick={() => handleCopyCouponCode(confirmRedeemCoupon.code)}
              >
                {copiedCouponCode ? "คัดลอกแล้ว" : "คัดลอก"}
              </button>
            </div>

            <p className="line-modal-desc compact">
              เมื่อกดยืนยัน คูปองจะถูกเปลี่ยนเป็นสถานะใช้แล้วทันที
            </p>

            <div className="line-modal-actions-inline">
              <button
                type="button"
                className="line-modal-secondary-btn compact"
                disabled={Boolean(redeemingCouponId)}
                onClick={() => setConfirmRedeemCoupon(null)}
              >
                ยกเลิก
              </button>
              <button
                type="button"
                className="line-modal-primary-btn compact"
                disabled={Boolean(redeemingCouponId)}
                onClick={handleConfirmRedeem}
              >
                {redeemingCouponId ? "กำลังยืนยัน..." : "ยืนยันใช้สิทธิ์"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: Compact Redemption Confirmation Receipt */}
      {receiptCoupon && (
        <div className="line-modal-backdrop" onClick={() => setReceiptCoupon(null)}>
          <div className="line-modal-sheet compact receipt" onClick={(e) => e.stopPropagation()}>
            <div className="line-receipt-header-compact">
              <span className={`line-receipt-status-pill ${receiptCoupon.isFreshRedemption ? "fresh" : "history"}`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {receiptCoupon.isFreshRedemption
                  ? "ใช้คูปองส่วนลดสำเร็จ"
                  : "ประวัติการใช้คูปอง"}
              </span>
              <h3>{stripEmoji(receiptCoupon.title)}</h3>
            </div>

            <div className="line-receipt-ticket compact">
              <div className="line-receipt-row">
                <span>รหัสคูปอง</span>
                <strong className="line-receipt-code">#{receiptCoupon.code}</strong>
              </div>
              <div className="line-receipt-row">
                <span>เวลาที่ใช้</span>
                <strong>{receiptCoupon.claimedAtFormatted}</strong>
              </div>
            </div>

            <p className="line-receipt-instruction compact">
              {receiptCoupon.isFreshRedemption
                ? "แจ้งรหัสนี้กับทางร้าน หรือดูในแชท LINE"
                : `ร้าน ${cleanCardTitle}`}
            </p>

            <button
              type="button"
              className="line-modal-primary-btn compact"
              onClick={() => setReceiptCoupon(null)}
            >
              ปิด
            </button>
          </div>
        </div>
      )}

      {/* Modal 3: QR Scanner with Collapsible Fallback Input */}
      {showScannerModal && (
        <div className="line-modal-backdrop" onClick={() => setShowScannerModal(false)}>
          <div className="line-modal-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>วิธีสแกนคิวอาร์โค้ดรับแต้ม</h3>
            <p className="line-modal-desc">
              ใช้กล้องในแอป LINE สแกนรูป QR Code ที่ได้รับจากทางร้าน หรือกดค้างที่รูป QR Code ในแชทแล้วเลือก <strong>“สแกนคิวอาร์โค้ด”</strong> แต้มจะเข้าบัตรอัตโนมัติทันที
            </p>

            <button
              type="button"
              className="line-scanner-fallback-toggle"
              onClick={() => setShowManualQrInput((prev) => !prev)}
            >
              {showManualQrInput ? "ซ่อนช่องวางลิงก์" : "มีปัญหาในการสแกน? วางลิงก์หรือรหัสจากร้าน"}
            </button>

            {showManualQrInput && (
              <div style={{ marginTop: 10 }}>
                <input
                  type="text"
                  className="line-modal-input"
                  placeholder="วางลิงก์ QR Code หรือรหัสจากร้าน..."
                  value={manualQrInput}
                  onChange={(e) => setManualQrInput(e.target.value)}
                />
                <button
                  type="button"
                  className="line-modal-primary-btn"
                  style={{ marginBottom: 8 }}
                  onClick={() => handleScannedQrText(manualQrInput)}
                  disabled={!manualQrInput.trim()}
                >
                  รับแต้มสะสม
                </button>
              </div>
            )}

            <div className="line-modal-actions" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="line-modal-secondary-btn"
                onClick={() => setShowScannerModal(false)}
              >
                ปิดหน้าต่าง
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 4: Customer Display Name Editor (only when testing without LIFF) */}
      {showNameModal && (
        <div className="line-modal-backdrop" onClick={() => setShowNameModal(false)}>
          <div className="line-modal-sheet" onClick={(e) => e.stopPropagation()}>
            <h3>ระบุชื่อของคุณบนบัตรสะสมแต้ม</h3>
            <p className="line-modal-desc">
              เมื่อเปิดใช้งานผ่านแอป LINE ระบบจะซิงก์รูปโปรไฟล์และชื่อ LINE ของคุณให้อัตโนมัติ
            </p>
            <input
              type="text"
              className="line-modal-input"
              placeholder="ระบุชื่อของคุณ..."
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
            <h3>วิธีใช้งานบัตรสะสมแต้ม {cleanCardTitle}</h3>
            <div className="line-modal-desc" style={{ textAlign: "left" }}>
              <p>
                <strong>1. สะสมแต้ม:</strong> สแกน QR Code ที่ได้รับจากทางร้านตามจำนวนกล่องที่สั่งซื้อ แต้มจะเข้าบัตรทันที
              </p>
              <p style={{ marginTop: 8 }}>
                <strong>2. ใช้คูปองส่วนลด:</strong> เมื่อสะสมครบ {config.stampsPerReward} แต้ม กดใช้คูปองในแถบ <strong>คูปองพร้อมใช้</strong> แล้วแจ้งรหัสหรือแคปหน้าจอส่งให้ร้านในแชท
              </p>
              <p style={{ marginTop: 8 }}>
                <strong>3. อายุแต้มสะสม:</strong> แต้มมีอายุ {config.validityMonths} เดือนนับจากการสแกนครั้งล่าสุด
              </p>
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
