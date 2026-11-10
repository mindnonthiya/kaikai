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

export async function sendLinePushMessage(
  channelAccessToken: string,
  toLineUserId: string,
  messages: Array<Record<string, unknown>>,
): Promise<boolean> {
  const token = channelAccessToken.trim();
  const to = toLineUserId.trim();
  // LINE real user IDs start with 'U' and are 33 chars long
  if (!token || !to.startsWith("U") || messages.length === 0) return false;

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
    return response.ok;
  } catch {
    return false;
  }
}
