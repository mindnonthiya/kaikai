"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  type LoyaltyActivityLogItem,
  type LoyaltyAdminCouponItem,
  fetchLoyaltyMemberDetailAction,
} from "@/app/actions/loyalty";
import {
  type LoyaltyConfig,
  type LoyaltyMemberSummary,
  formatThaiDateTime,
  formatValidTillDate,
} from "@/lib/loyalty";
import { LineProfileAvatar, formatActionLabel } from "./rewards-shared";

export function RewardsMemberModal({
  shopId,
  config,
  initialMember,
  isPending,
  refreshVersion,
  onClose,
  onQuickAdjustMember,
  onRedeemCouponCode,
}: {
  shopId: string;
  config: LoyaltyConfig;
  initialMember: LoyaltyMemberSummary;
  isPending: boolean;
  refreshVersion: number;
  onClose: () => void;
  onQuickAdjustMember: (memberId: string, delta: number) => void;
  onRedeemCouponCode: (code: string) => void;
}) {
  const [member, setMember] = useState<LoyaltyMemberSummary>(initialMember);
  const [coupons, setCoupons] = useState<LoyaltyAdminCouponItem[]>([]);
  const [logs, setLogs] = useState<LoyaltyActivityLogItem[]>([]);
  const [couponsTotal, setCouponsTotal] = useState<number>(
    initialMember.unclaimedCount + initialMember.claimedCount,
  );
  const [logsTotal, setLogsTotal] = useState<number>(0);
  const [isLoadingDetail, setIsLoadingDetail] = useState(true);
  const [customDeltaInput, setCustomDeltaInput] = useState("1");

  useEffect(() => {
    let cancelled = false;
    setIsLoadingDetail(true);
    void fetchLoyaltyMemberDetailAction({
      shopId,
      memberId: initialMember.id,
      rewardTitleFallback: config.rewardTitle,
    }).then((res) => {
      if (cancelled) return;
      setIsLoadingDetail(false);
      if (res.ok && res.member) {
        setMember(res.member);
        setCoupons(res.coupons);
        setLogs(res.logs);
        setCouponsTotal(res.couponsTotal ?? res.coupons.length);
        setLogsTotal(res.logsTotal ?? res.logs.length);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [shopId, initialMember.id, config.rewardTitle, refreshVersion]);

  return (
    <div
      className="ig-sheet-backdrop"
      onClick={() => !isPending && onClose()}
    >
      <div
        className="ig-sheet-card loyalty-member-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ig-sheet-header">
          <strong>ข้อมูลลูกค้า</strong>
          <button
            type="button"
            className="icon-button ig-sheet-close"
            onClick={onClose}
            aria-label="ปิดหน้าต่าง"
          >
            <X size={18} />
          </button>
        </div>

        <div className="loyalty-member-modal-body">
          {/* Customer LINE Profile Header */}
          <div className="loyalty-member-profile-hero">
            <LineProfileAvatar
              pictureUrl={member.pictureUrl}
              displayName={member.displayName}
              lineUserId={member.lineUserId}
              size={58}
            />
            <div className="loyalty-member-profile-meta">
              <div className="loyalty-member-name-row">
                <h3>{member.displayName}</h3>
                {member.lineUserId.startsWith("U") && (
                  <span className="loyalty-line-tag">LINE</span>
                )}
              </div>
              <span className="loyalty-member-meta">
                <code>{member.lineUserId}</code>
              </span>
            </div>
          </div>

          {/* Member Stamp Summary */}
          <div className="loyalty-member-stats-row">
            <div className="loyalty-member-stat-box">
              <span>แต้มปัจจุบัน</span>
              <strong>
                {member.stamps} / {config.stampsPerReward}
              </strong>
            </div>
            <div className="loyalty-member-stat-box">
              <span>สะสมรวม</span>
              <strong>{member.lifetimeStamps.toLocaleString()} แต้ม</strong>
            </div>
            <div className="loyalty-member-stat-box">
              <span>คูปองพร้อมใช้</span>
              <strong>{member.unclaimedCount.toLocaleString()} ใบ</strong>
            </div>
            <div className="loyalty-member-stat-box">
              <span>หมดอายุ</span>
              <strong>{formatValidTillDate(member.expiresAt)}</strong>
            </div>
          </div>

          {/* Manual Stamp Adjustment Box */}
          <div className="loyalty-adjust-box">
            <strong>ปรับแต้มลูกค้า</strong>
            <div className="loyalty-adjust-quick-row">
              {[1, 2, 3, 5].map((pts) => (
                <button
                  key={`add-${pts}`}
                  type="button"
                  className="button ghost"
                  disabled={isPending}
                  onClick={() => onQuickAdjustMember(member.id, pts)}
                >
                  +{pts}
                </button>
              ))}
              {[-1, -2].map((pts) => (
                <button
                  key={`sub-${pts}`}
                  type="button"
                  className="button ghost"
                  disabled={isPending || member.stamps <= 0}
                  onClick={() => onQuickAdjustMember(member.id, pts)}
                >
                  {pts}
                </button>
              ))}
            </div>

            <form
              className="loyalty-adjust-custom-row"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(customDeltaInput);
                if (Number.isFinite(n) && Math.round(n) !== 0) {
                  onQuickAdjustMember(member.id, Math.round(n));
                }
              }}
            >
              <input
                type="number"
                min={-30}
                max={30}
                value={customDeltaInput}
                onChange={(e) => setCustomDeltaInput(e.target.value)}
                placeholder="เช่น 4 หรือ -3"
              />
              <button type="submit" className="button primary" disabled={isPending}>
                บันทึกแต้ม
              </button>
            </form>
          </div>

          {/* Customer's Coupons */}
          <div className="loyalty-modal-section">
            <strong>
              คูปอง ({isLoadingDetail ? "กำลังโหลด..." : `${couponsTotal.toLocaleString()} ใบ`})
            </strong>
            {isLoadingDetail ? (
              <p className="field-hint">กำลังโหลดคูปอง...</p>
            ) : coupons.length === 0 ? (
              <p className="field-hint">ยังไม่มีคูปอง</p>
            ) : (
              <div className="loyalty-clean-list">
                {coupons.map((c) => (
                  <div key={c.id} className="loyalty-clean-row">
                    <div>
                      <strong>
                        #{c.code} · {c.title}
                      </strong>
                      <span className="loyalty-member-meta" style={{ display: "block" }}>
                        {c.status === "unclaimed"
                          ? `ออกเมื่อ ${formatThaiDateTime(c.issuedAt)}`
                          : `ใช้แล้วเมื่อ ${formatThaiDateTime(c.claimedAt)}`}
                      </span>
                    </div>
                    {c.status === "unclaimed" ? (
                      <button
                        type="button"
                        className="button primary"
                        disabled={isPending}
                        onClick={() => onRedeemCouponCode(c.code)}
                      >
                        ตัดสิทธิ์
                      </button>
                    ) : (
                      <span className="loyalty-coupon-status claimed">ใช้แล้ว</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Customer's Recent Logs */}
          <div className="loyalty-modal-section">
            <strong>
              ประวัติแต้ม ({isLoadingDetail ? "กำลังโหลด..." : `${logsTotal.toLocaleString()} รายการ`})
            </strong>
            {isLoadingDetail ? (
              <p className="field-hint">กำลังโหลดประวัติ...</p>
            ) : logs.length === 0 ? (
              <p className="field-hint">ยังไม่มีประวัติ</p>
            ) : (
              <div className="loyalty-clean-list">
                {logs.map((log) => (
                  <div key={log.id} className="loyalty-clean-row">
                    <div>
                      <strong>{formatActionLabel(log.action)}</strong>
                      <span className="loyalty-member-meta" style={{ display: "block" }}>
                        {log.note ? `${log.note} · ` : ""}
                        {formatThaiDateTime(log.createdAt)}
                      </span>
                    </div>
                    <span className="loyalty-balance-note">
                      {log.pointsDelta !== 0
                        ? `${log.pointsDelta > 0 ? `+${log.pointsDelta}` : log.pointsDelta} แต้ม · `
                        : ""}
                      คงเหลือ {log.balanceAfter}/{config.stampsPerReward}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
