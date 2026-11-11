"use client";

import { useState } from "react";

export type LoyaltyHubTab = "overview" | "qr" | "members" | "coupons" | "settings";
export type MemberFilter = "all" | "has_coupon" | "near_reward";
export type CouponSubTab = "unclaimed" | "claimed" | "logs";

export function LineProfileAvatar({
  pictureUrl,
  displayName,
  lineUserId,
  size = 40,
}: {
  pictureUrl?: string | null;
  displayName: string;
  lineUserId?: string;
  size?: number;
}) {
  const [imgBroken, setImgBroken] = useState(false);
  const cleanName = (displayName || "ลูกค้า LINE").trim();
  const initial = Array.from(cleanName)[0] ?? "ล";
  const isLineLinked = Boolean(lineUserId && lineUserId.startsWith("U"));
  const showImage = Boolean(pictureUrl && !imgBroken);

  return (
    <div
      className="loyalty-avatar-wrap"
      style={{ width: size, height: size }}
      title={isLineLinked ? `${cleanName} (เชื่อมต่อบัญชี LINE)` : cleanName}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={pictureUrl!}
          alt={cleanName}
          className="loyalty-avatar-img"
          onError={() => setImgBroken(true)}
        />
      ) : (
        <div
          className="loyalty-avatar-fallback"
          style={{ fontSize: Math.max(12, Math.round(size * 0.4)) }}
        >
          {initial}
        </div>
      )}
      {isLineLinked && (
        <span className="loyalty-avatar-line-dot" title="เชื่อมต่อบัญชี LINE แล้ว">
          L
        </span>
      )}
    </div>
  );
}

export function formatActionLabel(action: string): string {
  switch (action) {
    case "qr_claim":
      return "สแกน QR รับแต้ม";
    case "coupon_redeem":
      return "ลูกค้าใช้สิทธิ์คูปอง";
    case "admin_coupon_redeem":
      return "ร้านค้าตัดสิทธิ์คูปอง";
    case "manual_adjust":
      return "ร้านค้าปรับแต้ม";
    case "expired_reset":
      return "แต้มหมดอายุตามกำหนด";
    default:
      return action;
  }
}
