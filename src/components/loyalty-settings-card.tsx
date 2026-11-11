import Link from "next/link";
import { ExternalLink, Gift, QrCode, Settings2, Ticket } from "lucide-react";
import type { LoyaltyAdminSnapshot, LoyaltySettingsSummary } from "@/app/actions/loyalty";

export function LoyaltySettingsCard({
  shopName,
  summary,
  snapshot,
}: {
  shopName: string;
  summary?: LoyaltySettingsSummary;
  snapshot?: LoyaltyAdminSnapshot;
}) {
  const config = summary?.config ?? snapshot?.config;
  if (!config) return null;

  const totalMembers =
    summary?.totalMembers ?? snapshot?.metrics?.totalMembers ?? snapshot?.members.length ?? 0;
  const readyCouponsCount =
    summary?.readyCouponsCount ??
    snapshot?.metrics?.readyCouponsCount ??
    (snapshot?.recentCoupons ?? []).filter((c) => c.status === "unclaimed").length;
  const failedPushCount =
    summary?.failedPushCount ?? snapshot?.metrics?.failedPushCount ?? 0;
  const isLineReady = Boolean(
    config.liffId && (config.hasChannelAccessToken || config.channelAccessToken),
  );

  return (
    <section className="panel settings-card loyalty-settings-summary-card">
      <div className="loyalty-summary-card-head">
        <div>
          <span className="loyalty-summary-eyebrow">
            <Gift size={13} /> ระบบสะสมแต้ม LINE OA
          </span>
          <h2>บัตรสะสมแต้ม ({shopName})</h2>
          <p className="field-hint">
            ย้ายไปจัดการแบบเต็มรูปแบบที่เมนูหลัก <strong>“ระบบสะสมแต้ม”</strong> เพื่อความสะดวกและรวดเร็ว
          </p>
        </div>
        <span className={`loyalty-status-pill ${config.enabled ? "on" : "off"}`}>
          <span className="loyalty-status-dot" />
          {config.enabled ? "เปิดใช้งาน" : "ปิดใช้งาน"}
        </span>
      </div>

      <div className="loyalty-summary-rows">
        <div className="connection-row">
          <span>กติกาบัตรปัจจุบัน</span>
          <strong>
            สะสม {config.stampsPerReward} แต้ม รับ “{config.rewardTitle}” (อายุ {config.validityMonths} เดือน)
          </strong>
        </div>
        <div className="connection-row">
          <span>การเชื่อมต่อ LINE OA & LIFF</span>
          <strong className={isLineReady ? "text-ok" : "text-warn"}>
            {isLineReady ? "เชื่อมต่อครบแล้ว" : "รอตั้งค่า LIFF / Access Token"}
          </strong>
        </div>
        <div className="connection-row">
          <span>ข้อมูลสมาชิกและคูปอง</span>
          <strong>
            สมาชิก {totalMembers.toLocaleString()} คน · คูปองพร้อมใช้ {readyCouponsCount.toLocaleString()} ใบ
            {failedPushCount > 0 ? ` · ส่งแจ้งเตือนค้าง ${failedPushCount} รายการ` : ""}
          </strong>
        </div>
      </div>

      <div className="loyalty-summary-actions">
        <Link href="/rewards" className="button primary">
          <Settings2 size={16} />
          เปิดหน้าจัดการระบบสะสมแต้ม
        </Link>
        <Link href="/rewards?tab=qr" className="button ghost">
          <QrCode size={16} />
          QR 1–10 กล่อง
        </Link>
        <Link href="/rewards?tab=coupons" className="button ghost">
          <Ticket size={16} />
          ตรวจรหัสคูปอง
        </Link>
        <a
          href={`/loyalty?s=${encodeURIComponent(config.shopSecret)}`}
          target="_blank"
          rel="noreferrer"
          className="button ghost"
        >
          <ExternalLink size={16} />
          ดูหน้าบัตรลูกค้า
        </a>
      </div>
    </section>
  );
}
