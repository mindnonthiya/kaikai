export const LOYALTY_SETTINGS_KEY = "line_loyalty";
export const LINE_LOYALTY_SETTINGS_KEY = LOYALTY_SETTINGS_KEY;

export const LOYALTY_POINT_TIERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const LOYALTY_ADMIN_PAGE_SIZE = 20;

export const DEFAULT_LOYALTY_CARD_TITLE = "GaiTomNamPla";
export const DEFAULT_LOYALTY_CARD_HEADLINE = "สะสม 10 กล่อง ลด 50%";
export const DEFAULT_LOYALTY_REWARD_TITLE = "ลด 50% เมนูหลัก 1 กล่อง";
export const DEFAULT_LOYALTY_STAMPS_PER_REWARD = 10;
export const DEFAULT_LOYALTY_VALIDITY_MONTHS = 3;
export const DEFAULT_LOYALTY_COOLDOWN_MINUTES = 5;

export function stripEmoji(value: string): string {
  return String(value ?? "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export const DEFAULT_LOYALTY_RULES_TEXT = [
  "- ซื้อเมนูหลัก 1 กล่อง รับ 1 แต้ม (ข้าวไก่ / กับข้าว)",
  "- สะสมครบ 10 แต้ม แลกรับส่วนลด 50% สำหรับเมนูหลัก 1 กล่องในออเดอร์ถัดไป",
  "- แต้มมีอายุ 3 เดือน นับจากวันที่สั่งซื้อครั้งล่าสุด",
  "- สิทธิ์ส่วนลดใช้ได้ 1 สิทธิ์ ต่อ 1 ออเดอร์",
  "- ส่วนลดไม่สามารถแลกหรือเปลี่ยนเป็นเงินสดได้",
].join("\n");

export type LoyaltyNotifyMode = "all" | "reward_only" | "off";

export interface LoyaltyConfig {
  enabled: boolean;
  shopSecret: string;
  webhookSecret: string;
  qrTokens: Record<string, string>;
  cardTitle: string;
  cardHeadline: string;
  rewardTitle: string;
  stampsPerReward: number;
  validityMonths: number;
  cooldownMinutes: number;
  rulesText: string;
  liffId: string;
  botBasicId: string;
  notifyMode: LoyaltyNotifyMode;
  channelSecret: string;
  channelAccessToken: string;
  hasChannelSecret?: boolean;
  hasChannelAccessToken?: boolean;
  serverKeyHash?: string;
  webhookKeyHash?: string;
  serverKeyVersion?: number;
}

/**
 * Strips decrypted LINE credentials and server key hashes before sending LoyaltyConfig to Client Components.
 * Exposes only boolean flags (`hasChannelSecret`, `hasChannelAccessToken`).
 */
export function redactLoyaltyConfigForClient(
  config: LoyaltyConfig,
  decryptedSecret: string = config.channelSecret,
  decryptedAccessToken: string = config.channelAccessToken,
): LoyaltyConfig {
  const redacted: LoyaltyConfig = {
    ...config,
    channelSecret: "",
    channelAccessToken: "",
    serverKeyHash: "",
    hasChannelSecret: Boolean(decryptedSecret && decryptedSecret.trim().length > 0),
    hasChannelAccessToken: Boolean(decryptedAccessToken && decryptedAccessToken.trim().length > 0),
  };
  delete redacted.webhookKeyHash;
  delete redacted.serverKeyVersion;
  return redacted;
}

export function isValidLiffId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^[0-9]{8,14}-[A-Za-z0-9_-]{6,36}$/.test(trimmed);
}

export function isMissingRpcError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  const msg = String(error.message ?? "");
  return (
    msg.includes("Could not find the function") ||
    (msg.includes("function") && msg.includes("does not exist"))
  );
}

export function isMissingRelationError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error || isMissingRpcError(error)) return false;
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST204") return true;
  const msg = String(error.message ?? "");
  if (msg.includes("function")) return false;
  const mentionsLoyaltyTable =
    msg.includes("loyalty_members") ||
    msg.includes("loyalty_coupons") ||
    msg.includes("loyalty_logs") ||
    msg.includes("loyalty_push_queue");
  return mentionsLoyaltyTable && (msg.includes("does not exist") || msg.includes("schema cache"));
}

export function resolveTrustedAppOrigin(fallbackRequestUrl?: string): string {
  const configured = (
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.VERCEL_PROJECT_PRODUCTION_URL ??
    process.env.VERCEL_URL ??
    ""
  ).trim();
  if (configured) {
    const withProtocol = /^https?:\/\//i.test(configured)
      ? configured
      : `https://${configured}`;
    try {
      return new URL(withProtocol).origin;
    } catch {
      // Fallback below
    }
  }
  if (fallbackRequestUrl) {
    try {
      const parsed = new URL(fallbackRequestUrl);
      if (parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
        return parsed.origin;
      }
    } catch {
      // Ignore invalid fallback URL
    }
  }
  return "https://kaikai.vercel.app";
}

export function shouldSendStampPushNotification(
  notifyMode: LoyaltyNotifyMode,
  rewardsUnlocked: number,
): boolean {
  if (notifyMode === "off") return false;
  if (notifyMode === "reward_only") return rewardsUnlocked > 0;
  return true;
}

export interface LoyaltyCouponRecord {
  id: string;
  code: string;
  title: string;
  status: "unclaimed" | "claimed";
  issuedAt: string;
  claimedAt: string | null;
}

export interface LoyaltyMemberSummary {
  id: string;
  lineUserId: string;
  displayName: string;
  pictureUrl: string | null;
  stamps: number;
  lifetimeStamps: number;
  expiresAt: string | null;
  lastStampedAt: string | null;
  unclaimedCount: number;
  claimedCount: number;
}

export function generateLoyaltyToken(prefix: string, length = 18): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return `${prefix}_${out}`;
}

export function createDefaultQrTokens(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const tier of LOYALTY_POINT_TIERS) {
    map[String(tier)] = generateLoyaltyToken(`q${tier}`, 14);
  }
  return map;
}

export function generateCouponCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 6; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let code = "GT-";
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

export function normalizeLoyaltyConfig(
  raw?: unknown,
  fallbackShopName?: string,
): LoyaltyConfig {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawTokens =
    obj.qrTokens && typeof obj.qrTokens === "object"
      ? (obj.qrTokens as Record<string, unknown>)
      : {};
  const qrTokens: Record<string, string> = {};
  for (const tier of LOYALTY_POINT_TIERS) {
    const k = String(tier);
    const existing = typeof rawTokens[k] === "string" ? rawTokens[k].trim() : "";
    qrTokens[k] = existing.length >= 8 ? existing : generateLoyaltyToken(`q${tier}`, 14);
  }

  const shopSecret =
    typeof obj.shopSecret === "string" && obj.shopSecret.trim().length >= 8
      ? obj.shopSecret.trim()
      : generateLoyaltyToken("ls", 20);
  const webhookSecret =
    typeof obj.webhookSecret === "string" && obj.webhookSecret.trim().length >= 8
      ? obj.webhookSecret.trim()
      : generateLoyaltyToken("ws", 20);

  const stampsPerReward = Math.max(
    1,
    Math.min(30, Math.round(Number(obj.stampsPerReward) || DEFAULT_LOYALTY_STAMPS_PER_REWARD)),
  );
  const validityMonths = Math.max(
    1,
    Math.min(36, Math.round(Number(obj.validityMonths) || DEFAULT_LOYALTY_VALIDITY_MONTHS)),
  );
  const cooldownMinutes =
    obj.cooldownMinutes !== undefined && obj.cooldownMinutes !== null && obj.cooldownMinutes !== ""
      ? Math.max(0, Math.min(1440, Math.round(Number(obj.cooldownMinutes) || 0)))
      : DEFAULT_LOYALTY_COOLDOWN_MINUTES;

  const defaultTitle =
    fallbackShopName && fallbackShopName.trim() && fallbackShopName.trim() !== "kaikai"
      ? fallbackShopName.trim()
      : DEFAULT_LOYALTY_CARD_TITLE;

  const rawNotifyMode = typeof obj.notifyMode === "string" ? obj.notifyMode.trim() : "";
  const notifyMode: LoyaltyNotifyMode =
    rawNotifyMode === "reward_only" || rawNotifyMode === "off" ? rawNotifyMode : "all";

  const channelSecret = typeof obj.channelSecret === "string" ? obj.channelSecret.trim() : "";
  const channelAccessToken =
    typeof obj.channelAccessToken === "string" ? obj.channelAccessToken.trim() : "";

  return {
    enabled: Boolean(obj.enabled),
    shopSecret,
    webhookSecret,
    qrTokens,
    cardTitle:
      typeof obj.cardTitle === "string" && obj.cardTitle.trim()
        ? obj.cardTitle.trim()
        : defaultTitle,
    cardHeadline:
      typeof obj.cardHeadline === "string" && obj.cardHeadline.trim()
        ? obj.cardHeadline.trim()
        : DEFAULT_LOYALTY_CARD_HEADLINE,
    rewardTitle:
      typeof obj.rewardTitle === "string" && obj.rewardTitle.trim()
        ? obj.rewardTitle.trim()
        : DEFAULT_LOYALTY_REWARD_TITLE,
    stampsPerReward,
    validityMonths,
    cooldownMinutes,
    rulesText:
      typeof obj.rulesText === "string" && obj.rulesText.trim()
        ? obj.rulesText.trim()
        : DEFAULT_LOYALTY_RULES_TEXT,
    liffId: typeof obj.liffId === "string" ? obj.liffId.trim() : "",
    botBasicId: typeof obj.botBasicId === "string" ? obj.botBasicId.trim() : "",
    notifyMode,
    channelSecret,
    channelAccessToken,
    hasChannelSecret:
      typeof obj.hasChannelSecret === "boolean" ? obj.hasChannelSecret : Boolean(channelSecret),
    hasChannelAccessToken:
      typeof obj.hasChannelAccessToken === "boolean"
        ? obj.hasChannelAccessToken
        : Boolean(channelAccessToken),
    ...(typeof obj.serverKeyHash === "string" && obj.serverKeyHash.trim()
      ? { serverKeyHash: obj.serverKeyHash.trim() }
      : {}),
    ...(typeof obj.webhookKeyHash === "string" && obj.webhookKeyHash.trim()
      ? { webhookKeyHash: obj.webhookKeyHash.trim() }
      : {}),
    ...(typeof obj.serverKeyVersion === "number" && Number.isFinite(obj.serverKeyVersion)
      ? { serverKeyVersion: obj.serverKeyVersion }
      : {}),
  };
}

export function computeStampAwardProgress(
  currentStamps: number,
  pointsAdded: number,
  stampsPerReward = DEFAULT_LOYALTY_STAMPS_PER_REWARD,
): {
  previousStamps: number;
  pointsAdded: number;
  newStamps: number;
  stampsPerReward: number;
  rewardsUnlocked: number;
  stampsRemaining: number;
} {
  const safeCurrent = Math.max(0, Math.floor(Number(currentStamps) || 0));
  const safeAdded = Math.max(0, Math.floor(Number(pointsAdded) || 0));
  const target = Math.max(1, Math.floor(Number(stampsPerReward) || 10));
  const combined = safeCurrent + safeAdded;
  const rewardsUnlocked = Math.floor(combined / target);
  const newStamps = combined % target;
  const stampsRemaining = target - newStamps;
  return {
    previousStamps: safeCurrent,
    pointsAdded: safeAdded,
    newStamps,
    stampsPerReward: target,
    rewardsUnlocked,
    stampsRemaining,
  };
}

export function computeExpiryDateIso(
  baseDate: Date = new Date(),
  validityMonths = DEFAULT_LOYALTY_VALIDITY_MONTHS,
): string {
  const d = new Date(baseDate.getTime());
  d.setMonth(d.getMonth() + Math.max(1, Math.round(validityMonths || 3)));
  return d.toISOString();
}

export function formatValidTillDate(
  isoOrDate?: string | Date | null,
  validityMonths = DEFAULT_LOYALTY_VALIDITY_MONTHS,
): string {
  let target: Date;
  if (isoOrDate instanceof Date) {
    target = Number.isNaN(isoOrDate.getTime()) ? new Date() : isoOrDate;
  } else if (typeof isoOrDate === "string" && isoOrDate.trim()) {
    const parsed = new Date(isoOrDate);
    target = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  } else {
    target = new Date();
    target.setMonth(target.getMonth() + Math.max(1, validityMonths));
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return formatter.format(target).replace(/\//g, ".");
}

export function formatThaiDateTime(isoOrDate?: string | Date | null): string {
  const date =
    isoOrDate instanceof Date
      ? isoOrDate
      : typeof isoOrDate === "string" && isoOrDate.trim()
        ? new Date(isoOrDate)
        : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(safeDate);
}

export function buildLoyaltyCardUrl(
  origin: string,
  shopSecret: string,
  liffId = "",
): string {
  const params = new URLSearchParams();
  params.set("s", shopSecret.trim());
  const cleanLiff = liffId.trim();
  if (cleanLiff) {
    return `https://liff.line.me/${cleanLiff}?${params.toString()}`;
  }
  const cleanOrigin = origin.replace(/\/+$/, "");
  return `${cleanOrigin}/loyalty?${params.toString()}`;
}

export function buildLoyaltyClaimUrl(
  origin: string,
  shopSecret: string,
  points: number,
  token: string,
  liffId = "",
): string {
  const params = new URLSearchParams();
  params.set("s", shopSecret.trim());
  params.set("p", String(Math.round(points)));
  params.set("t", token.trim());
  const cleanLiff = liffId.trim();
  if (cleanLiff) {
    return `https://liff.line.me/${cleanLiff}?${params.toString()}`;
  }
  const cleanOrigin = origin.replace(/\/+$/, "");
  return `${cleanOrigin}/loyalty?${params.toString()}`;
}

export function parseLoyaltyQueryParams(searchParams: URLSearchParams): {
  shopSecret: string;
  points: number | null;
  token: string;
} {
  let s = (searchParams.get("s") ?? "").trim();
  let rawP = (searchParams.get("p") ?? "").trim();
  let t = (searchParams.get("t") ?? "").trim();

  const liffState = searchParams.get("liff.state");
  if (liffState && (!s || !t)) {
    const queryStr = liffState.startsWith("?")
      ? liffState.slice(1)
      : liffState.includes("?")
        ? liffState.slice(liffState.indexOf("?") + 1)
        : liffState;
    const nested = new URLSearchParams(queryStr);
    if (!s) s = (nested.get("s") ?? "").trim();
    if (!rawP) rawP = (nested.get("p") ?? "").trim();
    if (!t) t = (nested.get("t") ?? "").trim();
  }

  const parsedP = Number(rawP);
  const points =
    Number.isFinite(parsedP) && parsedP >= 1 && parsedP <= 10 ? Math.round(parsedP) : null;

  return {
    shopSecret: s,
    points,
    token: t,
  };
}

export function buildStampAwardPlainText(input: {
  cardTitle: string;
  rewardTitle: string;
  displayName: string;
  pointsAdded: number;
  newStamps: number;
  stampsPerReward: number;
  rewardsUnlocked: number;
  validTill: string;
}): string {
  const cleanTitle = stripEmoji(input.cardTitle) || DEFAULT_LOYALTY_CARD_TITLE;
  const cleanReward = stripEmoji(input.rewardTitle) || DEFAULT_LOYALTY_REWARD_TITLE;
  const cleanName = stripEmoji(input.displayName) || "ลูกค้า LINE";
  const remaining = Math.max(0, input.stampsPerReward - input.newStamps);
  const lines = [
    `[${cleanTitle}]`,
    input.pointsAdded > 0
      ? `สะสมแต้มสำเร็จ +${input.pointsAdded} แต้ม (${cleanName})`
      : `ข้อมูลบัตรสะสมแต้ม (${cleanName})`,
    `แต้มสะสมปัจจุบัน: ${input.newStamps} / ${input.stampsPerReward} แต้ม`,
  ];
  if (input.rewardsUnlocked > 0) {
    lines.push(`ครบ ${input.stampsPerReward} แต้ม ได้รับคูปอง “${cleanReward}” จำนวน ${input.rewardsUnlocked} ใบ`);
  } else {
    lines.push(`สะสมอีก ${remaining} แต้ม รับสิทธิ์ “${cleanReward}”`);
  }
  lines.push(`แต้มใช้ได้ถึง ${input.validTill}`);
  return lines.join("\n");
}

export function buildStampAwardFlexMessage(input: {
  cardTitle: string;
  rewardTitle: string;
  displayName: string;
  pointsAdded: number;
  newStamps: number;
  stampsPerReward: number;
  rewardsUnlocked: number;
  validTill: string;
  cardUrl?: string;
}): Record<string, unknown> {
  const cleanTitle = stripEmoji(input.cardTitle) || DEFAULT_LOYALTY_CARD_TITLE;
  const cleanReward = stripEmoji(input.rewardTitle) || DEFAULT_LOYALTY_REWARD_TITLE;
  const remaining = Math.max(0, input.stampsPerReward - input.newStamps);
  const progressPercent = Math.min(
    100,
    Math.max(8, Math.round((input.newStamps / Math.max(1, input.stampsPerReward)) * 100)),
  );

  const badgeText =
    input.pointsAdded > 0 ? `+${input.pointsAdded} แต้ม` : "บัตรสะสมแต้ม";
  const headerTitle =
    input.rewardsUnlocked > 0
      ? "ได้รับคูปองส่วนลด"
      : input.pointsAdded > 0
        ? "สะสมแต้มสำเร็จ"
        : "บัตรสะสมแต้ม";

  const altSubtitle =
    input.pointsAdded > 0
      ? `สะสมแต้มสำเร็จ +${input.pointsAdded} แต้ม`
      : `แต้มสะสมปัจจุบัน ${input.newStamps}/${input.stampsPerReward} แต้ม`;

  const contents: Record<string, unknown> = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box",
      layout: "horizontal",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: "#FCE254",
      paddingAll: "12px",
      paddingBottom: "10px",
      contents: [
        {
          type: "box",
          layout: "vertical",
          flex: 1,
          contents: [
            {
              type: "text",
              text: cleanTitle,
              color: "#6B574C",
              weight: "bold",
              size: "xxs",
            },
            {
              type: "text",
              text: headerTitle,
              color: "#2E231E",
              weight: "bold",
              size: "md",
            },
          ],
        },
        {
          type: "box",
          layout: "vertical",
          backgroundColor: "#FFFFFF",
          cornerRadius: "14px",
          paddingStart: "8px",
          paddingEnd: "8px",
          paddingTop: "3px",
          paddingBottom: "3px",
          flex: 0,
          contents: [
            {
              type: "text",
              text: badgeText,
              color: input.pointsAdded > 0 ? "#FA5B5A" : "#2E231E",
              weight: "bold",
              size: "xs",
              align: "center",
            },
          ],
        },
      ],
    },
    body: {
      type: "box",
      layout: "vertical",
      backgroundColor: "#FFFDF7",
      spacing: "sm",
      paddingAll: "12px",
      contents: [
        {
          type: "box",
          layout: "baseline",
          justifyContent: "space-between",
          contents: [
            {
              type: "text",
              text: "แต้มสะสม",
              size: "xs",
              color: "#6B574C",
            },
            {
              type: "text",
              text: `${input.newStamps} / ${input.stampsPerReward} แต้ม`,
              size: "md",
              weight: "bold",
              color: "#2E231E",
            },
          ],
        },
        {
          type: "box",
          layout: "vertical",
          backgroundColor: "#EADBB3",
          height: "6px",
          cornerRadius: "3px",
          contents: [
            {
              type: "box",
              layout: "vertical",
              backgroundColor: input.rewardsUnlocked > 0 ? "#10B981" : "#FA5B5A",
              height: "6px",
              cornerRadius: "3px",
              width: `${progressPercent}%`,
              contents: [],
            },
          ],
        },
        {
          type: "text",
          text:
            input.rewardsUnlocked > 0
              ? `รับคูปอง “${cleanReward}” ${input.rewardsUnlocked} ใบ`
              : `อีก ${remaining} แต้ม รับ “${cleanReward}”`,
          wrap: true,
          size: "xxs",
          color: input.rewardsUnlocked > 0 ? "#065F46" : "#6B574C",
          weight: input.rewardsUnlocked > 0 ? "bold" : "regular",
        },
      ],
    },
    ...(input.cardUrl && input.cardUrl.startsWith("http")
      ? {
          footer: {
            type: "box",
            layout: "vertical",
            backgroundColor: "#FFFDF7",
            paddingAll: "10px",
            paddingTop: "0px",
            contents: [
              {
                type: "button",
                style: "primary",
                color: "#2E231E",
                height: "sm",
                action: {
                  type: "uri",
                  label: "ดูบัตรสะสมแต้ม",
                  uri: input.cardUrl,
                },
              },
            ],
          },
        }
      : {}),
  };

  return {
    type: "flex",
    altText: `${cleanTitle}: ${altSubtitle} (ตอนนี้มี ${input.newStamps}/${input.stampsPerReward} แต้ม)`,
    contents,
  };
}

export function buildCouponRedeemPlainText(input: {
  cardTitle: string;
  rewardTitle: string;
  couponCode: string;
  displayName: string;
  claimedAtText: string;
}): string {
  const cleanTitle = stripEmoji(input.cardTitle) || DEFAULT_LOYALTY_CARD_TITLE;
  const cleanReward = stripEmoji(input.rewardTitle) || DEFAULT_LOYALTY_REWARD_TITLE;
  const cleanName = stripEmoji(input.displayName) || "ลูกค้า LINE";
  return [
    `[${cleanTitle}] ยืนยันการใช้คูปองส่วนลด`,
    `รายการ: ${cleanReward}`,
    `รหัสอ้างอิง: #${input.couponCode}`,
    `สมาชิก: ${cleanName}`,
    `เวลาที่ใช้สิทธิ์: ${input.claimedAtText}`,
  ].join("\n");
}

export function buildCouponRedeemFlexMessage(input: {
  cardTitle: string;
  rewardTitle: string;
  couponCode: string;
  displayName: string;
  claimedAtText: string;
}): Record<string, unknown> {
  const cleanTitle = stripEmoji(input.cardTitle) || DEFAULT_LOYALTY_CARD_TITLE;
  const cleanReward = stripEmoji(input.rewardTitle) || DEFAULT_LOYALTY_REWARD_TITLE;
  return {
    type: "flex",
    altText: `ยืนยันการใช้คูปองส่วนลด: ${cleanReward} (#${input.couponCode})`,
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "horizontal",
        alignItems: "center",
        justifyContent: "space-between",
        backgroundColor: "#FCE254",
        paddingAll: "12px",
        paddingBottom: "10px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            flex: 1,
            contents: [
              {
                type: "text",
                text: cleanTitle,
                color: "#6B574C",
                weight: "bold",
                size: "xxs",
              },
              {
                type: "text",
                text: "ยืนยันใช้คูปองส่วนลด",
                color: "#2E231E",
                weight: "bold",
                size: "md",
              },
            ],
          },
          {
            type: "box",
            layout: "vertical",
            backgroundColor: "#10B981",
            cornerRadius: "14px",
            paddingStart: "8px",
            paddingEnd: "8px",
            paddingTop: "3px",
            paddingBottom: "3px",
            flex: 0,
            contents: [
              {
                type: "text",
                text: "ใช้แล้ว",
                color: "#FFFFFF",
                weight: "bold",
                size: "xxs",
                align: "center",
              },
            ],
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#FFFDF7",
        spacing: "xs",
        paddingAll: "12px",
        contents: [
          {
            type: "text",
            text: cleanReward,
            weight: "bold",
            size: "sm",
            color: "#2E231E",
            wrap: true,
          },
          {
            type: "box",
            layout: "baseline",
            justifyContent: "space-between",
            margin: "xs",
            contents: [
              {
                type: "text",
                text: `รหัส #${input.couponCode}`,
                weight: "bold",
                size: "xs",
                color: "#FA5B5A",
                flex: 0,
              },
              {
                type: "text",
                text: input.claimedAtText,
                size: "xxs",
                color: "#8A7569",
                align: "end",
                flex: 1,
              },
            ],
          },
        ],
      },
    },
  };
}
