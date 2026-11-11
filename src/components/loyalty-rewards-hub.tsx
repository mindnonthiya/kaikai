"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertCircle,
  ExternalLink,
  QrCode,
  Settings2,
  ShieldCheck,
  Ticket,
  Users,
  X,
} from "lucide-react";
import {
  type LoyaltyAdminSnapshot,
  adjustMemberStampsAction,
  regenerateLoyaltyQrTokensAction,
  retryFailedLoyaltyPushJobsAction,
  testLineConnectionAction,
  verifyOrRedeemCouponByCodeAction,
} from "@/app/actions/loyalty";
import { type LoyaltyMemberSummary, buildLoyaltyCardUrl } from "@/lib/loyalty";
import { DEFAULT_SHOP_ID } from "@/lib/shop-scope";
import { RewardsCouponsTab } from "./rewards/rewards-coupons-tab";
import { RewardsMemberModal } from "./rewards/rewards-member-modal";
import { RewardsMembersTab } from "./rewards/rewards-members-tab";
import { RewardsOverviewTab } from "./rewards/rewards-overview-tab";
import { RewardsQrTab } from "./rewards/rewards-qr-tab";
import { RewardsSettingsTab } from "./rewards/rewards-settings-tab";
import {
  type CouponSubTab,
  LineProfileAvatar,
  type LoyaltyHubTab,
} from "./rewards/rewards-shared";

export { LineProfileAvatar, type LoyaltyHubTab };

const VALID_TABS = new Set<LoyaltyHubTab>(["overview", "qr", "members", "coupons", "settings"]);

export function LoyaltyRewardsHub({
  shopId = DEFAULT_SHOP_ID,
  shopName,
  snapshot,
  initialTab = "overview",
}: {
  shopId?: string;
  shopName: string;
  snapshot: LoyaltyAdminSnapshot;
  initialTab?: LoyaltyHubTab;
}) {
  const { config, persisted, isTableReady, members } = snapshot;
  const recentCoupons = useMemo(() => snapshot.recentCoupons ?? [], [snapshot.recentCoupons]);
  const recentPushJobs = useMemo(() => snapshot.recentPushJobs ?? [], [snapshot.recentPushJobs]);
  const recentLogs = useMemo(() => snapshot.recentLogs ?? [], [snapshot.recentLogs]);
  const loadedTabs = useMemo(() => new Set(snapshot.loadedTabs ?? [initialTab]), [snapshot.loadedTabs, initialTab]);

  const [activeTab, setActiveTabState] = useState<LoyaltyHubTab>(initialTab);
  const [couponSubTab, setCouponSubTab] = useState<CouponSubTab>("unclaimed");
  const [origin, setOrigin] = useState("https://kaikai.app");
  const [liffIdDraft, setLiffIdDraft] = useState(config.liffId);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [selectedMember, setSelectedMember] = useState<LoyaltyMemberSummary | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [isPending, startTransition] = useTransition();

  // Sync activeTab with URL query parameter (?tab=...) so refresh & back/forward work
  const handleSelectTab = useCallback((nextTab: LoyaltyHubTab) => {
    setActiveTabState(nextTab);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (nextTab === "overview") {
        url.searchParams.delete("tab");
      } else {
        url.searchParams.set("tab", nextTab);
      }
      window.history.pushState({ tab: nextTab }, "", url.toString());
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setOrigin(window.location.origin);

    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const raw = (params.get("tab") ?? "").trim() as LoyaltyHubTab;
      setActiveTabState(VALID_TABS.has(raw) ? raw : "overview");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    setLiffIdDraft(config.liffId);
  }, [config.liffId]);

  const cardPreviewUrl = useMemo(
    () => buildLoyaltyCardUrl(origin, config.shopSecret, liffIdDraft),
    [origin, config.shopSecret, liffIdDraft],
  );

  const liffEndpointUrl = useMemo(() => `${origin}/loyalty`, [origin]);
  const webhookUrl = useMemo(
    () => `${origin}/api/line/webhook?shop=${encodeURIComponent(config.webhookSecret)}`,
    [origin, config.webhookSecret],
  );

  const metrics = snapshot.metrics ?? {
    totalMembers: snapshot.membersTotal ?? members.length,
    scansTodayCount: 0,
    pointsTodayCount: 0,
    scans7dCount: 0,
    points7dCount: 0,
    readyCouponsCount: recentCoupons.filter((c) => c.status === "unclaimed").length,
    usedCouponsCount: recentCoupons.filter((c) => c.status === "claimed").length,
    failedPushCount: recentPushJobs.filter((j) => j.status.startsWith("failed")).length,
    pendingPushCount: 0,
  };

  const handleCopyText = async (key: string, textToCopy: string) => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // Ignore clipboard error
    }
  };

  const handleConfirmRegenerateQr = () => {
    startTransition(async () => {
      const res = await regenerateLoyaltyQrTokensAction();
      setActionNotice({
        ok: Boolean(res.ok),
        text: res.ok ? (res.message ?? "รีเซ็ตรหัส QR สำเร็จ") : (res.error ?? "เกิดข้อผิดพลาด"),
      });
    });
  };

  const handleQuickAdjustMember = (memberId: string, delta: number) => {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("member_id", memberId);
      fd.set("delta_stamps", String(delta));
      const res = await adjustMemberStampsAction(fd);
      if (res.ok) {
        setRefreshVersion((v) => v + 1);
      }
      setActionNotice({
        ok: Boolean(res.ok),
        text: res.ok ? (res.message ?? "ปรับแต้มสำเร็จ") : (res.error ?? "เกิดข้อผิดพลาด"),
      });
    });
  };

  const handleRedeemCouponCode = (codeToRedeem: string) => {
    const clean = codeToRedeem.replace(/^#/, "").trim();
    if (!clean) return;
    startTransition(async () => {
      const fd = new FormData();
      fd.set("coupon_code", clean);
      const res = await verifyOrRedeemCouponByCodeAction(fd);
      if (res.ok) {
        setRefreshVersion((v) => v + 1);
      }
      setActionNotice({
        ok: Boolean(res.ok),
        text: res.ok ? (res.message ?? "ตรวจสอบคูปองสำเร็จ") : (res.error ?? "ไม่พบรหัสคูปอง"),
      });
    });
  };

  const handleRetryPushJobs = (jobId?: string) => {
    startTransition(async () => {
      const fd = new FormData();
      if (jobId) fd.set("job_id", jobId);
      const res = await retryFailedLoyaltyPushJobsAction(fd);
      if (res.ok) {
        setRefreshVersion((v) => v + 1);
      }
      setActionNotice({
        ok: Boolean(res.ok),
        text: res.ok
          ? (res.message ?? "สั่งส่งข้อความซ้ำเรียบร้อยแล้ว")
          : (res.error ?? "ไม่สามารถส่งข้อความซ้ำได้"),
      });
    });
  };

  const handleTestLineConnection = (draftToken: string) => {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("channel_access_token", draftToken);
      const res = await testLineConnectionAction(fd);
      setActionNotice({
        ok: Boolean(res.ok),
        text: res.ok
          ? (res.message ?? "เชื่อมต่อ LINE OA สำเร็จ")
          : (res.error ?? "เชื่อมต่อ LINE OA ไม่สำเร็จ"),
      });
    });
  };

  const isLineReady = Boolean(
    config.liffId && (config.hasChannelAccessToken || config.channelAccessToken),
  );

  return (
    <div className="loyalty-hub-wrap">
      {/* Top Status & Navigation Header */}
      <section className="panel loyalty-hub-top-panel">
        <div className="loyalty-hub-top-row">
          <div>
            <div className="loyalty-hub-badges">
              <span className={`loyalty-status-pill ${config.enabled ? "on" : "off"}`}>
                <span className="loyalty-status-dot" />
                {config.enabled ? "เปิดใช้งาน" : "ปิดใช้งาน"}
              </span>
              <span className={`loyalty-status-pill ${isLineReady ? "line-ok" : "line-warn"}`}>
                {isLineReady ? "เชื่อม LINE แล้ว" : "ยังไม่เชื่อม LINE"}
              </span>
            </div>
            <h2 className="loyalty-hub-title">
              {config.cardTitle || shopName} · {config.cardHeadline}
            </h2>
            <p className="loyalty-hub-subtitle">
              ครบ {config.stampsPerReward} แต้ม รับ “{config.rewardTitle}” · อายุแต้ม{" "}
              {config.validityMonths} เดือน
            </p>
          </div>

          <div className="loyalty-hub-top-actions">
            <a
              href={`/loyalty?s=${encodeURIComponent(config.shopSecret)}`}
              target="_blank"
              rel="noreferrer"
              className="button ghost"
            >
              <ExternalLink size={15} />
              ดูบัตรลูกค้า
            </a>
          </div>
        </div>

        {/* Warning Banners if DB migration or first save is needed */}
        {!isTableReady && (
          <div className="loyalty-admin-banner warn" style={{ marginTop: 12, marginBottom: 0 }}>
            <AlertCircle size={18} />
            <div>
              <strong>ยังไม่ได้สร้างตารางแต้มสะสมในฐานข้อมูล</strong>
              <p>
                รันไฟล์ <code>202611110001_line_loyalty.sql</code> และ{" "}
                <code>202611110002_loyalty_admin_rpcs.sql</code> ใน Supabase SQL Editor ก่อนใช้งาน
              </p>
            </div>
          </div>
        )}

        {!persisted && (
          <div className="loyalty-admin-banner info" style={{ marginTop: 12, marginBottom: 0 }}>
            <AlertCircle size={18} />
            <div>
              <strong>เริ่มใช้งานร้าน {shopName}</strong>
              <p>ไปที่แท็บ “ตั้งค่า” แล้วกดบันทึก 1 ครั้งเพื่อเปิดใช้งาน QR Code</p>
            </div>
          </div>
        )}

        {/* 5 Main Tabs */}
        <div className="loyalty-hub-tabs" aria-label="เมนูจัดการระบบสะสมแต้ม">
          <button
            type="button"
            className={`loyalty-hub-tab ${activeTab === "overview" ? "active" : ""}`}
            onClick={() => handleSelectTab("overview")}
          >
            <ShieldCheck size={17} />
            <span>ภาพรวม</span>
          </button>
          <button
            type="button"
            className={`loyalty-hub-tab ${activeTab === "qr" ? "active" : ""}`}
            onClick={() => handleSelectTab("qr")}
          >
            <QrCode size={17} />
            <span>QR โค้ด</span>
            <span className="loyalty-hub-tab-badge hide-on-mobile-tab">1–10</span>
          </button>
          <button
            type="button"
            className={`loyalty-hub-tab ${activeTab === "members" ? "active" : ""}`}
            onClick={() => handleSelectTab("members")}
          >
            <Users size={17} />
            <span>ลูกค้า</span>
            {metrics.totalMembers > 0 && (
              <span className="loyalty-hub-tab-badge">
                {metrics.totalMembers.toLocaleString()}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`loyalty-hub-tab ${activeTab === "coupons" ? "active" : ""}`}
            onClick={() => handleSelectTab("coupons")}
          >
            <Ticket size={17} />
            <span>คูปอง</span>
            {metrics.readyCouponsCount > 0 && (
              <span className="loyalty-hub-tab-badge highlight">
                {metrics.readyCouponsCount.toLocaleString()}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`loyalty-hub-tab ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => handleSelectTab("settings")}
          >
            <Settings2 size={17} />
            <span>ตั้งค่า</span>
          </button>
        </div>
      </section>

      {actionNotice && (
        <div className={`form-notice ${actionNotice.ok ? "ok" : "err"} loyalty-hub-notice`}>
          <span>{actionNotice.text}</span>
          <button
            type="button"
            className="loyalty-notice-close"
            onClick={() => setActionNotice(null)}
            aria-label="ปิดข้อความ"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {activeTab === "overview" && (
        <RewardsOverviewTab
          config={config}
          persisted={persisted}
          metrics={metrics}
          recentPushJobs={recentPushJobs}
          recentLogs={recentLogs}
          cardPreviewUrl={cardPreviewUrl}
          copiedKey={copiedKey}
          isPending={isPending}
          onSelectTab={handleSelectTab}
          onSelectCouponSubTab={setCouponSubTab}
          onCopyText={handleCopyText}
          onRetryPushJobs={handleRetryPushJobs}
        />
      )}

      {activeTab === "qr" && (
        <RewardsQrTab
          shopName={shopName}
          config={config}
          origin={origin}
          liffIdDraft={liffIdDraft}
          copiedKey={copiedKey}
          isPending={isPending}
          onCopyText={handleCopyText}
          onConfirmRegenerateQr={handleConfirmRegenerateQr}
        />
      )}

      {activeTab === "members" && (
        <RewardsMembersTab
          shopId={shopId}
          config={config}
          initialMembers={members}
          initialTotal={snapshot.membersTotal ?? metrics.totalMembers}
          initiallyLoaded={loadedTabs.has("members")}
          isPending={isPending}
          refreshVersion={refreshVersion}
          onSelectMember={(m) => setSelectedMember(m)}
          onQuickAdjustMember={handleQuickAdjustMember}
        />
      )}

      {activeTab === "coupons" && (
        <RewardsCouponsTab
          shopId={shopId}
          config={config}
          metrics={metrics}
          initialCoupons={recentCoupons}
          initialLogs={recentLogs}
          initialLogsTotal={snapshot.logsTotal ?? recentLogs.length}
          initiallyLoadedCoupons={loadedTabs.has("coupons")}
          subTab={couponSubTab}
          onSelectSubTab={setCouponSubTab}
          isPending={isPending}
          refreshVersion={refreshVersion}
          onRedeemCouponCode={handleRedeemCouponCode}
        />
      )}

      {activeTab === "settings" && (
        <RewardsSettingsTab
          shopName={shopName}
          config={config}
          liffIdDraft={liffIdDraft}
          onChangeLiffIdDraft={setLiffIdDraft}
          liffEndpointUrl={liffEndpointUrl}
          webhookUrl={webhookUrl}
          copiedKey={copiedKey}
          isPending={isPending}
          onCopyText={handleCopyText}
          onTestLineConnection={handleTestLineConnection}
        />
      )}

      {selectedMember && (
        <RewardsMemberModal
          shopId={shopId}
          config={config}
          initialMember={selectedMember}
          isPending={isPending}
          refreshVersion={refreshVersion}
          onClose={() => setSelectedMember(null)}
          onQuickAdjustMember={handleQuickAdjustMember}
          onRedeemCouponCode={handleRedeemCouponCode}
        />
      )}
    </div>
  );
}
