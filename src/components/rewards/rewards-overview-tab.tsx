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
          <span className="loyalty-kpi-label">สมาชิกสะสมแต้มทั้งหมด</span>
          <strong className="loyalty-kpi-value">{metrics.totalMembers.toLocaleString()} คน</strong>
          <span className="loyalty-kpi-sub">ซิงก์ชื่อและรูปโปรไฟล์จาก LINE</span>
        </div>

        <div className="panel loyalty-kpi-card">
          <span className="loyalty-kpi-label">การสแกนรับแต้มวันนี้</span>
          <strong className="loyalty-kpi-value">
            {metrics.scansTodayCount.toLocaleString()} ครั้ง{" "}
            <small>(+{metrics.pointsTodayCount} แต้ม)</small>
          </strong>
          <span className="loyalty-kpi-sub">
            7 วันล่าสุด: {metrics.scans7dCount.toLocaleString()} ครั้ง (+{metrics.points7dCount.toLocaleString()} แต้ม)
          </span>
        </div>

        <div className="panel loyalty-kpi-card">
          <span className="loyalty-kpi-label">คูปองส่วนลดพร้อมใช้</span>
          <strong className="loyalty-kpi-value">{metrics.readyCouponsCount.toLocaleString()} ใบ</strong>
          <span className="loyalty-kpi-sub">
            ใช้สิทธิ์ไปแล้วทั้งหมด {metrics.usedCouponsCount.toLocaleString()} ใบ
          </span>
        </div>

        <div className="panel loyalty-kpi-card">
          <span className="loyalty-kpi-label">สถานะส่งแจ้งเตือน LINE OA</span>
          <strong
            className={`loyalty-kpi-value ${metrics.failedPushCount > 0 ? "text-danger" : "text-ok"}`}
          >
            {metrics.failedPushCount > 0
              ? `ส่งไม่สำเร็จ ${metrics.failedPushCount.toLocaleString()} รายการ`
              : "ทำงานปกติ"}
          </strong>
          <span className="loyalty-kpi-sub">
            โหมดแจ้งเตือน:{" "}
            {config.notifyMode === "all"
              ? "แจ้งเตือนทุกครั้งที่สแกน"
              : config.notifyMode === "reward_only"
                ? "เฉพาะเมื่อครบรับคูปอง"
                : "ปิดการส่งข้อความ"}
          </span>
        </div>
      </div>

      {/* Quick Actions & Connection Health */}
      <div className="loyalty-overview-two-col">
        <section className="panel loyalty-section-card">
          <div className="loyalty-section-head">
            <div>
              <h3>ทางลัดการใช้งานประจำวัน</h3>
              <p className="field-hint">กดเลือกงานที่ใช้บ่อยสำหรับหน้าร้านและแชท LINE</p>
            </div>
          </div>
          <div className="loyalty-quick-actions-grid">
            <button
              type="button"
              className="loyalty-quick-btn"
              onClick={() => onSelectTab("qr")}
            >
              <QrCode size={20} />
              <div>
                <strong>ดาวน์โหลด QR 1–10 กล่อง</strong>
                <small>บันทึกรูปส่งให้ลูกค้าในแชท</small>
              </div>
            </button>

            <button
              type="button"
              className="loyalty-quick-btn"
              onClick={() => onSelectTab("coupons")}
            >
              <Ticket size={20} />
              <div>
                <strong>ตรวจและตัดสิทธิ์รหัสคูปอง</strong>
                <small>ค้นหารหัส #GT-XXXXXX ของลูกค้า</small>
              </div>
            </button>

            <button
              type="button"
              className="loyalty-quick-btn"
              onClick={() => onSelectTab("members")}
            >
              <Users size={20} />
              <div>
                <strong>ดูรายชื่อและปรับแต้มลูกค้า</strong>
                <small>ค้นหาชื่อ LINE และเพิ่ม/ลดแต้ม</small>
              </div>
            </button>

            <button
              type="button"
              className="loyalty-quick-btn"
              onClick={() => onCopyText("card-link", cardPreviewUrl)}
            >
              {copiedKey === "card-link" ? <Check size={20} /> : <Copy size={20} />}
              <div>
                <strong>
                  {copiedKey === "card-link" ? "คัดลอกลิงก์บัตรแล้ว" : "คัดลอกลิงก์หน้าบัตร"}
                </strong>
                <small>สำหรับส่งให้ลูกค้าเช็กแต้ม</small>
              </div>
            </button>
          </div>
        </section>

        <section className="panel loyalty-section-card">
          <div className="loyalty-section-head">
            <div>
              <h3>สถานะการเชื่อมต่อ LINE OA</h3>
              <p className="field-hint">ตรวจสอบความพร้อมของระบบเชื่อมต่อบัญชี LINE</p>
            </div>
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
              <span>LIFF ID (ซิงก์รูปและชื่อ LINE ลูกค้า)</span>
              <strong className={config.liffId ? "text-ok" : "text-warn"}>
                {config.liffId ? `เชื่อมต่อแล้ว (${config.liffId})` : "ยังไม่ได้ระบุ LIFF ID"}
              </strong>
            </div>
            <div className="loyalty-health-row">
              <span>Channel Access Token (ส่งข้อความแจ้งแต้ม)</span>
              <strong className={hasAccessToken ? "text-ok" : "text-warn"}>
                {hasAccessToken ? "ตั้งค่าและเข้ารหัสบนเซิร์ฟเวอร์แล้ว" : "ยังไม่ได้ระบุ Token"}
              </strong>
            </div>
            <div className="loyalty-health-row">
              <span>LINE OA Basic ID</span>
              <strong>{config.botBasicId || "—"}</strong>
            </div>
            <div className="loyalty-health-row">
              <span>การบันทึกตั้งค่าร้าน</span>
              <strong className={persisted ? "text-ok" : "text-warn"}>
                {persisted ? "พร้อมใช้งาน" : "รอกดบันทึกครั้งแรก"}
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
          <div>
            <h3>ความเคลื่อนไหวล่าสุด</h3>
            <p className="field-hint">รายการสแกนรับแต้มและใช้คูปองล่าสุดของลูกค้า</p>
          </div>
          <button
            type="button"
            className="button ghost"
            onClick={() => {
              onSelectTab("coupons");
              onSelectCouponSubTab("logs");
            }}
          >
            ดูประวัติทั้งหมด
          </button>
        </div>

        {recentLogs.length === 0 ? (
          <div className="loyalty-empty-box">ยังไม่มีประวัติการสแกนสะสมแต้มในร้านนี้</div>
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
