import { NextResponse } from "next/server";
import { hasSupabaseEnv } from "@/lib/env";
import {
  fetchShopLoyaltyServerCredentials,
  sendLineReplyMessage,
  verifyLineWebhookSignature,
} from "@/lib/line-messaging";
import {
  DEFAULT_LOYALTY_CARD_TITLE,
  buildLoyaltyCardUrl,
  buildStampAwardFlexMessage,
  formatValidTillDate,
  resolveTrustedAppOrigin,
} from "@/lib/loyalty";
import { createSupabaseServerClient } from "@/lib/supabase/server";

interface LineWebhookEvent {
  type?: string;
  replyToken?: string;
  source?: {
    type?: string;
    userId?: string;
  };
  message?: {
    type?: string;
    text?: string;
  };
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "kaikai-line-loyalty-webhook",
  });
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const webhookSecret = (url.searchParams.get("w") ?? url.searchParams.get("secret") ?? "").trim();
    const rawBody = await request.text();

    if (!rawBody || !hasSupabaseEnv || !webhookSecret) {
      return NextResponse.json({ ok: true });
    }

    const supabase = await createSupabaseServerClient();
    const creds = await fetchShopLoyaltyServerCredentials(supabase, webhookSecret);

    if (!creds.ok || !creds.enabled) {
      return NextResponse.json({ ok: true });
    }

    const { shopSecret, channelSecret, channelAccessToken, liffId } = creds;

    if (channelSecret) {
      const signature = request.headers.get("x-line-signature");
      if (!verifyLineWebhookSignature(rawBody, signature, channelSecret)) {
        return NextResponse.json({ ok: false, message: "Invalid LINE signature" }, { status: 401 });
      }
    }

    const payload = JSON.parse(rawBody) as { events?: LineWebhookEvent[] };
    const events = Array.isArray(payload.events) ? payload.events : [];

    // Empty events array is sent when clicking "Verify" in LINE Developers Console
    if (events.length === 0 || !channelAccessToken) {
      return NextResponse.json({ ok: true });
    }

    const trustedOrigin = resolveTrustedAppOrigin(request.url);
    const cardUrl = buildLoyaltyCardUrl(trustedOrigin, shopSecret, liffId);

    for (const event of events) {
      if (event.type !== "message" || event.message?.type !== "text") continue;
      const replyToken = String(event.replyToken ?? "").trim();
      const lineUserId = String(event.source?.userId ?? "").trim();
      const textMsg = String(event.message.text ?? "").trim();
      if (!replyToken || !lineUserId || !textMsg) continue;

      // 1. Check if text contains a #STAMP:<points>:<token> trigger
      const stampMatch = /#STAMP:(\d{1,2}):([A-Za-z0-9_-]+)/i.exec(textMsg);
      if (stampMatch) {
        const points = Number(stampMatch[1]);
        const token = stampMatch[2];
        const { data: claimData } = await supabase.rpc("claim_loyalty_stamps", {
          p_shop_secret: shopSecret,
          p_points: points,
          p_token: token,
          p_line_user_id: lineUserId,
          p_display_name: "ลูกค้า LINE",
          p_picture_url: null,
        });

        const claim = (claimData ?? {}) as Record<string, unknown>;
        if (claim.ok) {
          const validTill = formatValidTillDate(claim.expiresAt ? String(claim.expiresAt) : null);
          const flex = buildStampAwardFlexMessage({
            cardTitle: String(claim.cardTitle ?? creds.cardTitle ?? DEFAULT_LOYALTY_CARD_TITLE),
            rewardTitle: String(claim.rewardTitle ?? creds.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง"),
            displayName: String(claim.displayName ?? "ลูกค้า LINE"),
            pointsAdded: Number(claim.pointsAdded ?? points),
            newStamps: Number(claim.newStamps ?? 0),
            stampsPerReward: Number(claim.stampsPerReward ?? 10),
            rewardsUnlocked: Number(claim.rewardsUnlocked ?? 0),
            validTill,
            cardUrl,
          });
          await sendLineReplyMessage(channelAccessToken, replyToken, [flex]);
        } else if (claim.message) {
          await sendLineReplyMessage(channelAccessToken, replyToken, [
            {
              type: "text",
              text: String(claim.message),
            },
          ]);
        }
        continue;
      }

      // 2. Check if customer is asking to check their stamp balance
      const normalized = textMsg.toLowerCase();
      if (
        normalized === "เช็คแต้ม" ||
        normalized === "แต้มสะสม" ||
        normalized === "บัตรสะสมแต้ม" ||
        normalized === "สะสมแต้ม" ||
        normalized === "stamp"
      ) {
        const { data: stateData } = await supabase.rpc("get_loyalty_card_state", {
          p_shop_secret: shopSecret,
          p_line_user_id: lineUserId,
          p_display_name: "ลูกค้า LINE",
          p_picture_url: null,
        });
        const state = (stateData ?? {}) as Record<string, unknown>;
        if (state.ok) {
          const member = (state.member ?? {}) as Record<string, unknown>;
          const cfg = (state.config ?? {}) as Record<string, unknown>;
          const stamps = Number(member.stamps ?? 0);
          const target = Number(cfg.stampsPerReward ?? 10);
          const validTill = formatValidTillDate(member.expiresAt ? String(member.expiresAt) : null);
          const flex = buildStampAwardFlexMessage({
            cardTitle: String(cfg.cardTitle ?? DEFAULT_LOYALTY_CARD_TITLE),
            rewardTitle: String(cfg.rewardTitle ?? "ลด 50% เมนูหลัก 1 กล่อง"),
            displayName: String(member.displayName ?? "ลูกค้า LINE"),
            pointsAdded: 0,
            newStamps: stamps,
            stampsPerReward: target,
            rewardsUnlocked: 0,
            validTill,
            cardUrl,
          });
          await sendLineReplyMessage(channelAccessToken, replyToken, [flex]);
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
