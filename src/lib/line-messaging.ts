import { createHash, createHmac, timingSafeEqual } from "crypto";
import { decryptLoyaltySecret, getLoyaltyServerKeyHash } from "@/lib/loyalty-crypto";
import type { LoyaltyNotifyMode } from "@/lib/loyalty";

export interface VerifiedLineProfile {
  ok: true;
  userId: string;
  displayName: string;
  pictureUrl: string | null;
}

export interface FailedLineVerification {
  ok: false;
  reason: string;
}

export type LineTokenVerificationResult = VerifiedLineProfile | FailedLineVerification;

const verifiedTokenCache = new Map<
  string,
  { profile: VerifiedLineProfile; expiresAtMs: number }
>();

export function extractLineChannelIdFromLiffId(liffId?: string | null): string {
  const clean = (liffId ?? "").trim();
  const match = /^([0-9]{8,14})-[A-Za-z0-9_-]{4,36}$/.exec(clean);
  return match ? match[1] : "";
}

export async function verifyLineLiffAccessToken(
  accessToken: string,
  expectedLiffId?: string | null,
): Promise<LineTokenVerificationResult> {
  const token = (accessToken ?? "").trim();
  if (!token || token.length < 12) {
    return { ok: false, reason: "MISSING_ACCESS_TOKEN" };
  }

  const expectedChannelId = extractLineChannelIdFromLiffId(expectedLiffId);
  const cacheKey = createHash("sha256")
    .update(`${expectedChannelId}:${token}`, "utf8")
    .digest("hex");

  const now = Date.now();
  const cached = verifiedTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > now) {
    return cached.profile;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const verifyPromise = expectedChannelId
      ? fetch(
          `https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(token)}`,
          { method: "GET", signal: controller.signal, cache: "no-store" },
        )
      : Promise.resolve(null);

    const profilePromise = fetch("https://api.line.me/v2/profile", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
      cache: "no-store",
    });

    const [verifyRes, profileRes] = await Promise.all([verifyPromise, profilePromise]);

    if (verifyRes) {
      if (!verifyRes.ok) {
        return { ok: false, reason: `LINE_VERIFY_${verifyRes.status}` };
      }
      const verifyData = (await verifyRes.json().catch(() => ({}))) as {
        client_id?: string;
        expires_in?: number;
      };
      if (
        expectedChannelId &&
        verifyData.client_id &&
        String(verifyData.client_id).trim() !== expectedChannelId
      ) {
        return { ok: false, reason: "CHANNEL_ID_MISMATCH" };
      }
      if (typeof verifyData.expires_in === "number" && verifyData.expires_in <= 0) {
        return { ok: false, reason: "TOKEN_EXPIRED" };
      }
    }

    if (!profileRes.ok) {
      return { ok: false, reason: `LINE_PROFILE_${profileRes.status}` };
    }

    const profileData = (await profileRes.json().catch(() => ({}))) as {
      userId?: string;
      displayName?: string;
      pictureUrl?: string;
    };

    const userId = String(profileData.userId ?? "").trim();
    if (!userId.startsWith("U")) {
      return { ok: false, reason: "INVALID_LINE_USER_ID" };
    }

    const verified: VerifiedLineProfile = {
      ok: true,
      userId,
      displayName: String(profileData.displayName ?? "ลูกค้า LINE").trim() || "ลูกค้า LINE",
      pictureUrl: profileData.pictureUrl ? String(profileData.pictureUrl).trim() : null,
    };

    if (verifiedTokenCache.size > 300) {
      verifiedTokenCache.clear();
    }
    verifiedTokenCache.set(cacheKey, {
      profile: verified,
      expiresAtMs: now + 60_000,
    });

    return verified;
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      reason: isAbort ? "LINE_VERIFY_TIMEOUT" : "LINE_VERIFY_NETWORK_ERROR",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function verifyLineWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  channelSecret: string,
): boolean {
  const secret = decryptLoyaltySecret(channelSecret).trim();
  if (!secret || !signatureHeader) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader.trim(), "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export async function sendLineReplyMessage(
  channelAccessToken: string,
  replyToken: string,
  messages: Array<Record<string, unknown>>,
): Promise<boolean> {
  const token = decryptLoyaltySecret(channelAccessToken).trim();
  if (!token || !replyToken || messages.length === 0) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: messages.slice(0, 5),
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export interface LinePushResult {
  ok: boolean;
  status?: number;
  reason?: string;
}

export async function sendLinePushMessage(
  channelAccessToken: string,
  toLineUserId: string,
  messages: Array<Record<string, unknown>>,
  fallbackPlainText?: string,
): Promise<boolean> {
  const res = await sendLinePushMessageDetailed(
    channelAccessToken,
    toLineUserId,
    messages,
    fallbackPlainText,
  );
  return res.ok;
}

export async function sendLinePushMessageDetailed(
  channelAccessToken: string,
  toLineUserId: string,
  messages: Array<Record<string, unknown>>,
  fallbackPlainText?: string,
): Promise<LinePushResult> {
  const token = decryptLoyaltySecret(channelAccessToken).trim();
  const to = toLineUserId.trim();

  if (!token) {
    return { ok: false, reason: "MISSING_CHANNEL_ACCESS_TOKEN" };
  }
  if (!to.startsWith("U")) {
    return { ok: false, reason: "NOT_LINE_USER_ID" };
  }
  if (messages.length === 0) {
    return { ok: false, reason: "EMPTY_MESSAGES" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to,
        messages: messages.slice(0, 5),
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      return { ok: true, status: response.status, reason: "PUSH_REQUEST_ACCEPTED" };
    }

    // Do NOT retry plain text when error is 401 (Invalid Token), 403 (Forbidden), or 429 (Quota Exceeded)
    if (response.status === 401) {
      return { ok: false, status: 401, reason: "LINE_TOKEN_INVALID_401" };
    }
    if (response.status === 403) {
      return { ok: false, status: 403, reason: "LINE_FORBIDDEN_403" };
    }
    if (response.status === 429) {
      return { ok: false, status: 429, reason: "LINE_QUOTA_EXCEEDED_429" };
    }

    const errBody = await response.text().catch(() => "");

    // Only retry with plain text on 400 when Flex payload formatting (e.g. non-HTTPS URI in local dev) failed,
    // and NOT when the target userId itself is rejected ("Failed to send messages" / invalid 'to')
    const isInvalidRecipient =
      errBody.includes("property, 'to'") || errBody.includes("Failed to send messages");

    if (response.status === 400 && !isInvalidRecipient && fallbackPlainText && fallbackPlainText.trim()) {
      const retryResponse = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          to,
          messages: [{ type: "text", text: fallbackPlainText.trim() }],
        }),
        signal: controller.signal,
      });
      if (retryResponse.ok) {
        return { ok: true, status: retryResponse.status, reason: "PUSH_REQUEST_ACCEPTED" };
      }
    }

    if (response.status === 400 && isInvalidRecipient) {
      return { ok: false, status: 400, reason: "LINE_PROVIDER_OR_FRIEND_MISMATCH_400" };
    }

    return {
      ok: false,
      status: response.status,
      reason: `LINE_API_${response.status}: ${errBody.slice(0, 160)}`,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      reason: isAbort ? "LINE_API_TIMEOUT" : err instanceof Error ? err.message : "NETWORK_ERROR",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface DecryptedShopLoyaltyCredentials {
  ok: boolean;
  enabled: boolean;
  shopSecret: string;
  channelSecret: string;
  channelAccessToken: string;
  liffId: string;
  notifyMode: LoyaltyNotifyMode;
  cardTitle: string;
  rewardTitle: string;
  stampsPerReward: number;
}

export async function fetchShopLoyaltyServerCredentials(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => any },
  lookupSecret: string,
  legacyFallback?: {
    channelAccessToken?: string;
    liffId?: string;
    notifyMode?: string;
  },
): Promise<DecryptedShopLoyaltyCredentials> {
  const cleanSecret = (lookupSecret ?? "").trim();
  const empty: DecryptedShopLoyaltyCredentials = {
    ok: false,
    enabled: false,
    shopSecret: cleanSecret,
    channelSecret: "",
    channelAccessToken: decryptLoyaltySecret(legacyFallback?.channelAccessToken ?? ""),
    liffId: (legacyFallback?.liffId ?? "").trim(),
    notifyMode:
      legacyFallback?.notifyMode === "reward_only" || legacyFallback?.notifyMode === "off"
        ? legacyFallback.notifyMode
        : "all",
    cardTitle: "GaiTomNamPla 🐔",
    rewardTitle: "ลด 50% เมนูหลัก 1 กล่อง",
    stampsPerReward: 10,
  };

  if (!cleanSecret) return empty;

  const { data, error } = await supabase.rpc("get_loyalty_server_credentials", {
    p_lookup_secret: cleanSecret,
    p_server_key_hash: getLoyaltyServerKeyHash(),
  });

  if (!error && data && (data as Record<string, unknown>).ok) {
    const raw = data as Record<string, unknown>;
    const rawMode = String(raw.notifyMode ?? "all").trim();
    return {
      ok: true,
      enabled: Boolean(raw.enabled ?? true),
      shopSecret: String(raw.shopSecret ?? cleanSecret).trim(),
      channelSecret: decryptLoyaltySecret(String(raw.channelSecret ?? "")),
      channelAccessToken: decryptLoyaltySecret(String(raw.channelAccessToken ?? "")),
      liffId: String(raw.liffId ?? legacyFallback?.liffId ?? "").trim(),
      notifyMode: rawMode === "reward_only" || rawMode === "off" ? rawMode : "all",
      cardTitle: String(raw.cardTitle ?? "GaiTomNamPla 🐔"),
      rewardTitle: String(raw.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง"),
      stampsPerReward: Number(raw.stampsPerReward ?? 10),
    };
  }

  return empty;
}
