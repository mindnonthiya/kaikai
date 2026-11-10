import { createHmac, timingSafeEqual } from "crypto";

export function verifyLineWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  channelSecret: string,
): boolean {
  const secret = channelSecret.trim();
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
  const token = channelAccessToken.trim();
  if (!token || !replyToken || messages.length === 0) return false;

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
    });
    return response.ok;
  } catch {
    return false;
  }
}

export interface LinePushResult {
  ok: boolean;
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
  const token = channelAccessToken.trim();
  const to = toLineUserId.trim();

  if (!token) {
    return { ok: false, reason: "MISSING_CHANNEL_ACCESS_TOKEN" };
  }
  // LINE real user IDs start with 'U' and are 33 chars long
  if (!to.startsWith("U")) {
    return { ok: false, reason: "NOT_LINE_USER_ID" };
  }
  if (messages.length === 0) {
    return { ok: false, reason: "EMPTY_MESSAGES" };
  }

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
    });

    if (response.ok) {
      return { ok: true };
    }

    // If Flex message failed (e.g. non-HTTPS cardUrl in dev), retry with plain text message
    if (fallbackPlainText && fallbackPlainText.trim()) {
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
      });
      if (retryResponse.ok) {
        return { ok: true };
      }
    }

    const errBody = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `LINE_API_${response.status}: ${errBody.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "NETWORK_ERROR",
    };
  }
}
