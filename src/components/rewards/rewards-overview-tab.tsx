"use client";

import { Check, Copy, QrCode, RefreshCw, Ticket, Users } from "lucide-react";
import type {
  LoyaltyActivityLogItem,
  LoyaltyOverviewMetrics,
  LoyaltyPushQueueSummary,
} from "@/app/actions/loyalty";
import { type LoyaltyConfig, formatThaiDateTime } from "@/lib/loyalty";
import {
  type CouponSubTab,
  LineProfileAvatar,
  type LoyaltyHubTab,
  formatActionLabel,
} from "./rewards-shared";

export function RewardsOverviewTab({
  config,
  persisted,
  metrics,
  recentPushJobs,
  recentLogs,
  cardPreviewUrl,
  copiedKey,
  isPending,
  onSelectTab,
  onSelectCouponSubTab,
  onCopyText,
  onRetryPushJobs,
}: {
  config: LoyaltyConfig;
  persisted: boolean;
  metrics: LoyaltyOverviewMetrics;
  recentPushJobs: LoyaltyPushQueueSummary[];
  recentLogs: LoyaltyActivityLogItem[];
  cardPreviewUrl: string;
  copiedKey: string | null;
  isPending: boolean;
  onSelectTab: (tab: LoyaltyHubTab) => void;
  onSelectCouponSubTab: (subTab: CouponSubTab) => void;
  onCopyText: (key: string, textToCopy: string) => void;
  onRetryPushJobs: (jobId?: string) => void;
}) {
  const hasAccessToken = Boolean(config.hasChannelAccessToken || config.channelAccessToken);

  return (
    <div className="loyalty-tab-content">
      <div className="loyalty-kpi-grid">
        <div className="panel loyalty-kpi-card">
          <span className="loyalty-kpi-label">ลูกค้าทั้งหมด</span>
          <strong className="loyalty-kpi-value">{metrics.totalMembers.toLocaleString()} คน</strong>
          <span className="loyalty-kpi-sub">ซิงก์จากบัญชี LINE</span>
        </div>

        <div className="panel loyalty-kpi-card">
          <span className="loyalty-kpi-label">สแกนวันนี้</span>
          <strong className="loyalty-kpi-value">
            {metrics.scansTodayCount.toLocaleString()} ครั้ง{" "}
            <small>(+{metrics.pointsTodayCount} แต้ม)</small>
          </strong>
          <span className="loyalty-kpi-sub">
            7 วันล่าสุด {metrics.scans7dCount.toLocaleString()} ครั้ง (+{metrics.points7dCount.toLocaleString()})
          </span>
        </div>

        <div className="panel loyalty-kpi-card">
          <span className="loyalty-kpi-label">คูปองพร้อมใช้</span>
          <strong className="loyalty-kpi-value">{metrics.readyCouponsCount.toLocaleString()} ใบ</strong>
          <span className="loyalty-kpi-sub">
            ใช้แล้ว {metrics.usedCouponsCount.toLocaleString()} ใบ
          </span>
        </div>

        <div className="panel loyalty-kpi-card">
          <span className="loyalty-kpi-label">แจ้งเตือน LINE</span>
          <strong
            className={`loyalty-kpi-value ${metrics.failedPushCount > 0 ? "text-danger" : "text-ok"}`}
          >
            {metrics.failedPushCount > 0
              ? `ค้างส่ง ${metrics.failedPushCount.toLocaleString()} รายการ`
              : "ปกติ"}
          </strong>
          <span className="loyalty-kpi-sub">
            {config.notifyMode === "all"
              ? "แจ้งทุกครั้งที่สแกน"
              : config.notifyMode === "reward_only"
                ? "เฉพาะเมื่อได้คูปอง"
                : "ปิดการส่งข้อความ"}
          </span>
        </div>
      </div>

      {/* Quick Actions & Connection Health */}
      <div className="loyalty-overview-two-col">
        <section className="panel loyalty-section-card">
          <div className="loyalty-section-head">
            <h3>ทางลัด</h3>
          </div>
          <div className="loyalty-quick-actions-grid">
            <button
              type="button"
              className="loyalty-quick-btn"
              onClick={() => onSelectTab("qr")}
            >
              <QrCode size={19} />
              <div>
                <strong>QR โค้ด 1–10 กล่อง</strong>
                <small>บันทึกรูปส่งให้ลูกค้า</small>
              </div>
            </button>

            <button
              type="button"
              className="loyalty-quick-btn"
              onClick={() => onSelectTab("coupons")}
            >
              <Ticket size={19} />
              <div>
                <strong>ตรวจรหัสคูปอง</strong>
                <small>ค้นหาและตัดสิทธิ์ส่วนลด</small>
              </div>
            </button>

            <button
              type="button"
              className="loyalty-quick-btn"
              onClick={() => onSelectTab("members")}
            >
              <Users size={19} />
              <div>
                <strong>รายชื่อลูกค้า</strong>
                <small>ดูแต้มและเพิ่ม/ลดแต้ม</small>
              </div>
            </button>

            <button
              type="button"
              className="loyalty-quick-btn"
              onClick={() => onCopyText("card-link", cardPreviewUrl)}
            >
              {copiedKey === "card-link" ? <Check size={19} /> : <Copy size={19} />}
              <div>
                <strong>
                  {copiedKey === "card-link" ? "คัดลอกลิงก์แล้ว" : "คัดลอกลิงก์หน้าบัตร"}
                </strong>
                <small>ส่งให้ลูกค้าเช็กแต้ม</small>
              </div>
            </button>
          </div>
        </section>

        <section className="panel loyalty-section-card">
          <div className="loyalty-section-head">
            <h3>การเชื่อมต่อ LINE</h3>
            <button
              type="button"
              className="button ghost"
              onClick={() => onSelectTab("settings")}
            >
              ตั้งค่า
            </button>
          </div>

          <div className="loyalty-health-list">
            <div className="loyalty-health-row">
              <span>LIFF ID</span>
              <strong className={config.liffId ? "text-ok" : "text-warn"}>
                {config.liffId ? config.liffId : "ยังไม่ระบุ"}
              </strong>
            </div>
            <div className="loyalty-health-row">
              <span>Access Token</span>
              <strong className={hasAccessToken ? "text-ok" : "text-warn"}>
                {hasAccessToken ? "เชื่อมต่อแล้ว" : "ยังไม่ระบุ"}
              </strong>
            </div>
            <div className="loyalty-health-row">
              <span>LINE OA</span>
              <strong>{config.botBasicId || "—"}</strong>
            </div>
            <div className="loyalty-health-row">
              <span>สถานะระบบ</span>
              <strong className={persisted ? "text-ok" : "text-warn"}>
                {persisted ? "พร้อมใช้งาน" : "รอกดบันทึก"}
              </strong>
            </div>
          </div>
        </section>
      </div>

      {/* Failed Push Queue Alert (if any) */}
      {(recentPushJobs.length > 0 || metrics.failedPushCount > 0) && (
        <section className="panel loyalty-section-card">
          <div className="loyalty-section-head">
            <div>
              <h3>คิวส่งข้อความแจ้งเตือน LINE ล่าสุด</h3>
              <p className="field-hint">
                ระบบส่งแจ้งเตือนในพื้นหลังอัตโนมัติ หากมีรายการส่งไม่สำเร็จสามารถกดสั่งส่งซ้ำได้
              </p>
            </div>
            {metrics.failedPushCount > 0 && (
              <button
                type="button"
                className="button primary"
                disabled={isPending}
                onClick={() => onRetryPushJobs()}
              >
                <RefreshCw size={15} />
                ส่งซ้ำรายการที่ค้าง ({metrics.failedPushCount.toLocaleString()})
              </button>
            )}
          </div>

          <div className="loyalty-clean-list">
            {recentPushJobs.slice(0, 6).map((job) => {
              const isFailed = job.status.startsWith("failed");
              const isSent = job.status === "sent";
              return (
                <div key={job.id} className="loyalty-clean-row">
                  <div className="loyalty-member-cell">
                    <LineProfileAvatar
                      pictureUrl={job.pictureUrl}
                      displayName={job.displayName ?? "ลูกค้า LINE"}
                      lineUserId={job.lineUserId}
                      size={36}
                    />
                    <div className="loyalty-member-info">
                      <strong>{job.displayName ?? "ลูกค้า LINE"}</strong>
                      <span className="loyalty-member-meta">
                        {job.eventType === "coupon_redeem"
                          ? "แจ้งเตือนใช้คูปองส่วนลด"
                          : "แจ้งเตือนสแกนรับแต้ม"}{" "}
                        · {formatThaiDateTime(job.sentAt ?? job.createdAt)}
                      </span>
                      {job.lastError && (
                        <span className="loyalty-error-note">สาเหตุ: {job.lastError}</span>
                      )}
                    </div>
                  </div>

                  <div className="loyalty-member-actions">
                    <span
                      className={`loyalty-coupon-status ${
                        isSent ? "claimed" : isFailed ? "unclaimed" : ""
                      }`}
                    >
                      {isSent
                        ? "ส่งสำเร็จ"
                        : job.status === "failed_quota"
                          ? "โควตาเต็ม"
                          : job.status === "failed_auth"
                            ? "Token ไม่ถูกต้อง"
                            : job.status === "failed_recipient"
                              ? "ยังไม่เพิ่มเพื่อน OA"
                              : isFailed
                                ? "ส่งไม่สำเร็จ"
                                : "กำลังส่ง"}
                    </span>
                    {isFailed && (
                      <button
                        type="button"
                        className="button ghost"
                        disabled={isPending}
                        onClick={() => onRetryPushJobs(job.id)}
                      >
                        ส่งซ้ำ
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Recent Activity Log Preview */}
      <section className="panel loyalty-section-card">
        <div className="loyalty-section-head">
          <h3>ความเคลื่อนไหวล่าสุด</h3>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              onSelectTab("coupons");
              onSelectCouponSubTab("logs");
            }}
          >
            ดูทั้งหมด
          </button>
        </div>

        {recentLogs.length === 0 ? (
          <div className="loyalty-empty-box">ยังไม่มีประวัติการสะสมแต้ม</div>
        ) : (
          <div className="loyalty-clean-list">
            {recentLogs.slice(0, 6).map((log) => (
              <div key={log.id} className="loyalty-clean-row">
                <div className="loyalty-member-cell">
                  <LineProfileAvatar
                    pictureUrl={log.pictureUrl}
                    displayName={log.displayName}
                    lineUserId={log.lineUserId}
                    size={38}
                  />
                  <div className="loyalty-member-info">
                    <strong>{log.displayName}</strong>
                    <span className="loyalty-member-meta">
                      {formatActionLabel(log.action)}
                      {log.note ? ` · ${log.note}` : ""} · {formatThaiDateTime(log.createdAt)}
                    </span>
                  </div>
                </div>
                <div className="loyalty-member-actions">
                  {log.pointsDelta !== 0 && (
                    <span
                      className={`loyalty-points-pill ${log.pointsDelta > 0 ? "plus" : "minus"}`}
                    >
                      {log.pointsDelta > 0 ? `+${log.pointsDelta}` : log.pointsDelta} แต้ม
                    </span>
                  )}
                  <span className="loyalty-balance-note">
                    คงเหลือ {log.balanceAfter}/{config.stampsPerReward}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
