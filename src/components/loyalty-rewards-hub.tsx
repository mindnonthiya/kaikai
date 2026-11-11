"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Minus,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Ticket,
  Users,
  X,
} from "lucide-react";
import {
  type LoyaltyActivityLogItem,
  type LoyaltyAdminCouponItem,
  type LoyaltyAdminSnapshot,
  adjustMemberStampsAction,
  regenerateLoyaltyQrTokensAction,
  retryFailedLoyaltyPushJobsAction,
  saveLoyaltyConfigAction,
  testLineConnectionAction,
  verifyOrRedeemCouponByCodeAction,
} from "@/app/actions/loyalty";
import { ActionForm } from "@/components/action-form";
import {
  LOYALTY_POINT_TIERS,
  type LoyaltyMemberSummary,
  buildLoyaltyCardUrl,
  buildLoyaltyClaimUrl,
  formatThaiDateTime,
  formatValidTillDate,
} from "@/lib/loyalty";
import { generateQrMatrix, qrMatrixToSvgPath } from "@/lib/qr-code";

export type LoyaltyHubTab = "overview" | "qr" | "members" | "coupons" | "settings";
type MemberFilter = "all" | "has_coupon" | "near_reward" | "expiring_soon";
type CouponSubTab = "unclaimed" | "claimed" | "logs";

const MEMBERS_PAGE_SIZE = 20;

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

function formatActionLabel(action: string): string {
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

export function LoyaltyRewardsHub({
  shopName,
  snapshot,
  initialTab = "overview",
}: {
  shopName: string;
  snapshot: LoyaltyAdminSnapshot;
  initialTab?: LoyaltyHubTab;
}) {
  const { config, persisted, isTableReady, members } = snapshot;
  const recentCoupons = useMemo(() => snapshot.recentCoupons ?? [], [snapshot.recentCoupons]);
  const recentPushJobs = useMemo(() => snapshot.recentPushJobs ?? [], [snapshot.recentPushJobs]);
  const recentLogs = useMemo(() => snapshot.recentLogs ?? [], [snapshot.recentLogs]);

  const [activeTab, setActiveTab] = useState<LoyaltyHubTab>(initialTab);
  const [origin, setOrigin] = useState("https://kaikai.app");
  const [liffIdDraft, setLiffIdDraft] = useState(config.liffId);
  const [accessTokenDraft, setAccessTokenDraft] = useState(config.channelAccessToken);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  // QR Tab states
  const [confirmResetQr, setConfirmResetQr] = useState(false);

  // Members Tab states
  const [memberSearch, setMemberSearch] = useState("");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("all");
  const [memberPage, setMemberPage] = useState(1);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [customDeltaInput, setCustomDeltaInput] = useState("1");

  // Coupons Tab states
  const [couponCodeInput, setCouponCodeInput] = useState("");
  const [couponSubTab, setCouponSubTab] = useState<CouponSubTab>("unclaimed");

  // Settings Tab states
  const [showAdvancedLine, setShowAdvancedLine] = useState(
    !config.liffId || !config.channelAccessToken,
  );
  const [showSetupGuide, setShowSetupGuide] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
    }
  }, []);

  useEffect(() => {
    setLiffIdDraft(config.liffId);
    setAccessTokenDraft(config.channelAccessToken);
  }, [config.liffId, config.channelAccessToken]);

  const qrCards = useMemo(() => {
    return LOYALTY_POINT_TIERS.map((points) => {
      const token = config.qrTokens[String(points)] ?? "";
      const url = buildLoyaltyClaimUrl(origin, config.shopSecret, points, token, liffIdDraft);
      const matrix = generateQrMatrix(url);
      const svg = qrMatrixToSvgPath(matrix, 2);
      return {
        points,
        token,
        url,
        matrix,
        svg,
      };
    });
  }, [origin, config.shopSecret, config.qrTokens, liffIdDraft]);

  const cardPreviewUrl = useMemo(
    () => buildLoyaltyCardUrl(origin, config.shopSecret, liffIdDraft),
    [origin, config.shopSecret, liffIdDraft],
  );

  const liffEndpointUrl = useMemo(() => `${origin}/loyalty`, [origin]);
  const webhookUrl = useMemo(
    () => `${origin}/api/line/webhook?shop=${encodeURIComponent(config.webhookSecret)}`,
    [origin, config.webhookSecret],
  );

  // Metrics
  const unclaimedCoupons = useMemo(
    () => recentCoupons.filter((c) => c.status === "unclaimed"),
    [recentCoupons],
  );
  const claimedCoupons = useMemo(
    () => recentCoupons.filter((c) => c.status === "claimed"),
    [recentCoupons],
  );
  const failedPushJobs = useMemo(
    () => recentPushJobs.filter((j) => j.status.startsWith("failed")),
    [recentPushJobs],
  );

  const metrics = snapshot.metrics ?? {
    totalMembers: members.length,
    scansTodayCount: 0,
    pointsTodayCount: 0,
    scans7dCount: 0,
    points7dCount: 0,
    readyCouponsCount: unclaimedCoupons.length,
    usedCouponsCount: claimedCoupons.length,
    failedPushCount: failedPushJobs.length,
    pendingPushCount: 0,
  };

  // Filtered & paginated members
  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    const nowMs = Date.now();
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    const nearThreshold = Math.max(1, config.stampsPerReward - 2);

    return members.filter((m) => {
      if (q) {
        const matchName = m.displayName.toLowerCase().includes(q);
        const matchId = m.lineUserId.toLowerCase().includes(q);
        if (!matchName && !matchId) return false;
      }

      if (memberFilter === "has_coupon") {
        return m.unclaimedCount > 0;
      }
      if (memberFilter === "near_reward") {
        return m.stamps >= nearThreshold && m.stamps < config.stampsPerReward;
      }
      if (memberFilter === "expiring_soon") {
        if (!m.expiresAt || m.stamps <= 0) return false;
        const diff = new Date(m.expiresAt).getTime() - nowMs;
        return diff > 0 && diff <= fourteenDaysMs;
      }
      return true;
    });
  }, [members, memberSearch, memberFilter, config.stampsPerReward]);

  const totalMemberPages = Math.max(1, Math.ceil(filteredMembers.length / MEMBERS_PAGE_SIZE));
  const safeMemberPage = Math.min(memberPage, totalMemberPages);
  const pagedMembers = useMemo(() => {
    const start = (safeMemberPage - 1) * MEMBERS_PAGE_SIZE;
    return filteredMembers.slice(start, start + MEMBERS_PAGE_SIZE);
  }, [filteredMembers, safeMemberPage]);

  const selectedMember: LoyaltyMemberSummary | null = useMemo(
    () => members.find((m) => m.id === selectedMemberId) ?? null,
    [members, selectedMemberId],
  );

  const selectedMemberCoupons: LoyaltyAdminCouponItem[] = useMemo(
    () => (selectedMember ? recentCoupons.filter((c) => c.memberId === selectedMember.id) : []),
    [recentCoupons, selectedMember],
  );

  const selectedMemberLogs: LoyaltyActivityLogItem[] = useMemo(
    () => (selectedMember ? recentLogs.filter((l) => l.memberId === selectedMember.id) : []),
    [recentLogs, selectedMember],
  );

  // Instant coupon code filter when typing in coupon input
  const matchingCoupons = useMemo(() => {
    const clean = couponCodeInput.replace(/^#/, "").trim().toUpperCase();
    if (!clean) return [];
    return recentCoupons.filter(
      (c) =>
        c.code.toUpperCase().includes(clean) ||
        c.displayName.toLowerCase().includes(clean.toLowerCase()),
    );
  }, [couponCodeInput, recentCoupons]);

  const handleCopyText = async (key: string, textToCopy: string) => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // Ignore clipboard error
    }
  };

  const handleDownloadQrPng = (points: number, url: string) => {
    const matrix = generateQrMatrix(url);
    const qrSize = matrix.length;
    const canvas = document.createElement("canvas");
    const width = 900;
    const height = 1120;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#E62134";
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.roundRect(54, 54, width - 108, height - 108, 36);
    ctx.fill();

    ctx.fillStyle = "#E62134";
    ctx.font = "800 44px -apple-system, BlinkMacSystemFont, 'Noto Sans Thai', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(config.cardTitle || shopName, width / 2, 145);

    ctx.fillStyle = "#111827";
    ctx.font = "700 34px -apple-system, BlinkMacSystemFont, 'Noto Sans Thai', sans-serif";
    ctx.fillText(`คิวอาร์โค้ดสะสมแต้มสำหรับ ${points} กล่อง`, width / 2, 205);

    ctx.fillStyle = "#1FC879";
    ctx.beginPath();
    ctx.roundRect(width / 2 - 170, 230, 340, 62, 31);
    ctx.fill();

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "800 32px -apple-system, BlinkMacSystemFont, 'Noto Sans Thai', sans-serif";
    ctx.fillText(`สแกนรับทันที +${points} แต้ม`, width / 2, 272);

    const qrBoxSize = 600;
    const qrStartX = (width - qrBoxSize) / 2;
    const qrStartY = 330;
    const modulePx = qrBoxSize / qrSize;

    ctx.fillStyle = "#111111";
    for (let r = 0; r < qrSize; r += 1) {
      for (let c = 0; c < qrSize; c += 1) {
        if (matrix[r][c]) {
          ctx.fillRect(
            Math.floor(qrStartX + c * modulePx),
            Math.floor(qrStartY + r * modulePx),
            Math.ceil(modulePx),
            Math.ceil(modulePx),
          );
        }
      }
    }

    ctx.fillStyle = "#4B5563";
    ctx.font = "600 26px -apple-system, BlinkMacSystemFont, 'Noto Sans Thai', sans-serif";
    ctx.fillText(
      `สะสมครบ ${config.stampsPerReward} แต้ม รับสิทธิ์ “${config.rewardTitle}”`,
      width / 2,
      985,
    );

    ctx.fillStyle = "#9CA3AF";
    ctx.font = "500 22px -apple-system, BlinkMacSystemFont, 'Noto Sans Thai', sans-serif";
    ctx.fillText("สแกนผ่านกล้อง LINE เพื่อรับแต้มและแจ้งเตือนในแชทอัตโนมัติ", width / 2, 1025);

    const dataUrl = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `qr-${points}-box.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleConfirmRegenerateQr = () => {
    startTransition(async () => {
      const res = await regenerateLoyaltyQrTokensAction();
      setConfirmResetQr(false);
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
        setCouponCodeInput("");
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
      setActionNotice({
        ok: Boolean(res.ok),
        text: res.ok
          ? (res.message ?? "สั่งส่งข้อความซ้ำเรียบร้อยแล้ว")
          : (res.error ?? "ไม่สามารถส่งข้อความซ้ำได้"),
      });
    });
  };

  const handleTestLineConnection = () => {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("channel_access_token", accessTokenDraft);
      const res = await testLineConnectionAction(fd);
      setActionNotice({
        ok: Boolean(res.ok),
        text: res.ok
          ? (res.message ?? "เชื่อมต่อ LINE OA สำเร็จ")
          : (res.error ?? "เชื่อมต่อ LINE OA ไม่สำเร็จ"),
      });
    });
  };

  const isLineReady = Boolean(config.liffId && config.channelAccessToken);

  return (
    <div className="loyalty-hub-wrap">
      {/* Top Status & Navigation Header */}
      <section className="panel loyalty-hub-top-panel">
        <div className="loyalty-hub-top-row">
          <div>
            <div className="loyalty-hub-badges">
              <span className={`loyalty-status-pill ${config.enabled ? "on" : "off"}`}>
                <span className="loyalty-status-dot" />
                {config.enabled ? "เปิดใช้งานสะสมแต้ม" : "ปิดใช้งานชั่วคราว"}
              </span>
              <span className={`loyalty-status-pill ${isLineReady ? "line-ok" : "line-warn"}`}>
                {isLineReady ? "เชื่อมต่อ LINE OA & LIFF แล้ว" : "รอตั้งค่าการเชื่อมต่อ LINE"}
              </span>
            </div>
            <h2 className="loyalty-hub-title">
              {config.cardTitle || shopName} · {config.cardHeadline}
            </h2>
            <p className="loyalty-hub-subtitle">
              สะสมครบ {config.stampsPerReward} แต้ม รับสิทธิ์ “{config.rewardTitle}” · อายุแต้ม{" "}
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
              <ExternalLink size={16} />
              ดูหน้าบัตรลูกค้า
            </a>
          </div>
        </div>

        {/* Warning Banners if DB migration or first save is needed */}
        {!isTableReady && (
          <div className="loyalty-admin-banner warn" style={{ marginTop: 14, marginBottom: 0 }}>
            <AlertCircle size={18} />
            <div>
              <strong>ยังไม่ได้สร้างตารางระบบสะสมแต้มในฐานข้อมูล</strong>
              <p>
                กรุณานำไฟล์ <code>supabase/migrations/202611110001_line_loyalty.sql</code> ไปรันใน
                Supabase SQL Editor ก่อนเริ่มใช้งานจริง
              </p>
            </div>
          </div>
        )}

        {!persisted && (
          <div className="loyalty-admin-banner info" style={{ marginTop: 14, marginBottom: 0 }}>
            <AlertCircle size={18} />
            <div>
              <strong>เริ่มใช้งานครั้งแรกสำหรับร้าน {shopName}</strong>
              <p>
                กรุณาไปที่แท็บ “ตั้งค่าระบบ” แล้วกดบันทึกการตั้งค่า 1 ครั้ง เพื่อเปิดใช้งานลิงก์บัตรสะสมแต้มและรหัส QR Code ของร้านนี้
              </p>
            </div>
          </div>
        )}

        {/* 5 Main Tabs */}
        <div className="loyalty-hub-tabs" aria-label="เมนูจัดการระบบสะสมแต้ม">
          <button
            type="button"
            className={`loyalty-hub-tab ${activeTab === "overview" ? "active" : ""}`}
            onClick={() => setActiveTab("overview")}
          >
            <ShieldCheck size={17} />
            <span>ภาพรวม</span>
          </button>
          <button
            type="button"
            className={`loyalty-hub-tab ${activeTab === "qr" ? "active" : ""}`}
            onClick={() => setActiveTab("qr")}
          >
            <QrCode size={17} />
            <span>QR โค้ด</span>
            <span className="loyalty-hub-tab-badge hide-on-mobile-tab">1–10</span>
          </button>
          <button
            type="button"
            className={`loyalty-hub-tab ${activeTab === "members" ? "active" : ""}`}
            onClick={() => setActiveTab("members")}
          >
            <Users size={17} />
            <span>ลูกค้า</span>
            {metrics.totalMembers > 0 && (
              <span className="loyalty-hub-tab-badge">{metrics.totalMembers}</span>
            )}
          </button>
          <button
            type="button"
            className={`loyalty-hub-tab ${activeTab === "coupons" ? "active" : ""}`}
            onClick={() => setActiveTab("coupons")}
          >
            <Ticket size={17} />
            <span>คูปอง</span>
            {metrics.readyCouponsCount > 0 && (
              <span className="loyalty-hub-tab-badge highlight">{metrics.readyCouponsCount}</span>
            )}
          </button>
          <button
            type="button"
            className={`loyalty-hub-tab ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => setActiveTab("settings")}
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

      {/* ============================================================
          TAB 1: ภาพรวม (Overview)
          ============================================================ */}
      {activeTab === "overview" && (
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
                7 วันล่าสุด: {metrics.scans7dCount} ครั้ง (+{metrics.points7dCount} แต้ม)
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
                  ? `ส่งไม่สำเร็จ ${metrics.failedPushCount} รายการ`
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
                  onClick={() => setActiveTab("qr")}
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
                  onClick={() => setActiveTab("coupons")}
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
                  onClick={() => setActiveTab("members")}
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
                  onClick={() => handleCopyText("card-link", cardPreviewUrl)}
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
                  onClick={() => setActiveTab("settings")}
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
                  <strong className={config.channelAccessToken ? "text-ok" : "text-warn"}>
                    {config.channelAccessToken ? "ตั้งค่าและเข้ารหัสแล้ว" : "ยังไม่ได้ระบุ Token"}
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
          {recentPushJobs.length > 0 && (
            <section className="panel loyalty-section-card">
              <div className="loyalty-section-head">
                <div>
                  <h3>คิวส่งข้อความแจ้งเตือน LINE ล่าสุด</h3>
                  <p className="field-hint">
                    ระบบส่งแจ้งเตือนในพื้นหลังอัตโนมัติ หากมีรายการส่งไม่สำเร็จสามารถกดสั่งส่งซ้ำได้
                  </p>
                </div>
                {failedPushJobs.length > 0 && (
                  <button
                    type="button"
                    className="button primary"
                    disabled={isPending}
                    onClick={() => handleRetryPushJobs()}
                  >
                    <RefreshCw size={15} />
                    ส่งซ้ำรายการที่ค้าง ({failedPushJobs.length})
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
                            onClick={() => handleRetryPushJobs(job.id)}
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
                  setActiveTab("coupons");
                  setCouponSubTab("logs");
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
      )}

      {/* ============================================================
          TAB 2: QR สะสมแต้ม (1–10 Box Static QR Gallery)
          ============================================================ */}
      {activeTab === "qr" && (
        <div className="loyalty-tab-content">
          <section className="panel loyalty-section-card">
            <div className="loyalty-section-head">
              <div>
                <h3>คิวอาร์โค้ดสะสมแต้มตามจำนวนกล่อง (1–10 กล่อง)</h3>
                <p className="field-hint">
                  ดาวน์โหลดรูป QR Code เก็บไว้ในเครื่องหรืออัลบั้มแชท เมื่อลูกค้าซื้อกี่กล่องให้ส่งรูปตามจำนวนกล่องนั้นได้เลย
                </p>
              </div>
            </div>

            <div className="loyalty-qr-grid">
              {qrCards.map((item) => (
                <div key={item.points} className="loyalty-qr-card">
                  <div className="loyalty-qr-card-top">
                    <span className="loyalty-qr-box-badge">ซื้อ {item.points} กล่อง</span>
                    <span className="loyalty-qr-point-badge">+{item.points} แต้ม</span>
                  </div>

                  <div className="loyalty-qr-svg-wrap" title={item.url}>
                    <svg
                      viewBox={`0 0 ${item.svg.viewBoxSize} ${item.svg.viewBoxSize}`}
                      className="loyalty-qr-svg"
                      shapeRendering="crispEdges"
                    >
                      <rect width="100%" height="100%" fill="#FFFFFF" />
                      <path d={item.svg.pathData} fill="#111111" />
                    </svg>
                  </div>

                  <div className="loyalty-qr-card-actions">
                    <button
                      type="button"
                      className="button primary loyalty-qr-dl-btn"
                      onClick={() => handleDownloadQrPng(item.points, item.url)}
                    >
                      <Download size={14} />
                      ดาวน์โหลด PNG ({item.points} กล่อง)
                    </button>
                    <div className="loyalty-qr-sub-actions">
                      <button
                        type="button"
                        className="button ghost"
                        onClick={() => handleCopyText(`qr-${item.points}`, item.url)}
                      >
                        {copiedKey === `qr-${item.points}` ? <Check size={14} /> : <Copy size={14} />}
                        {copiedKey === `qr-${item.points}` ? "คัดลอกแล้ว" : "คัดลอกลิงก์"}
                      </button>
                      <a
                        href={`/loyalty?s=${encodeURIComponent(config.shopSecret)}&p=${item.points}&t=${encodeURIComponent(item.token)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="button ghost"
                      >
                        ทดสอบสแกน
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="loyalty-qr-rotate-bar">
              <div>
                <strong>ต้องการเปลี่ยนรหัส QR Code ทั้งหมดใหม่หรือไม่?</strong>
                <p className="field-hint" style={{ margin: "2px 0 0" }}>
                  ใช้ในกรณีที่รูป QR เดิมหลุดออกไปภายนอก เมื่อรีเซ็ตแล้วรูป QR เดิมจะสแกนไม่ได้ แต่แต้มและคูปองของลูกค้ายังอยู่ครบ
                </p>
              </div>
              {!confirmResetQr ? (
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => setConfirmResetQr(true)}
                  disabled={isPending}
                >
                  <RefreshCw size={15} />
                  รีเซ็ตรหัส QR ทั้งหมด
                </button>
              ) : (
                <div className="loyalty-confirm-inline">
                  <button
                    type="button"
                    className="button primary"
                    onClick={handleConfirmRegenerateQr}
                    disabled={isPending}
                  >
                    ยืนยันเปลี่ยนรหัส QR ใหม่
                  </button>
                  <button
                    type="button"
                    className="button ghost"
                    onClick={() => setConfirmResetQr(false)}
                    disabled={isPending}
                  >
                    ยกเลิก
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {/* ============================================================
          TAB 3: ลูกค้า (Members with LINE Profile Photo & Name)
          ============================================================ */}
      {activeTab === "members" && (
        <div className="loyalty-tab-content">
          <section className="panel loyalty-section-card">
            <div className="loyalty-section-head">
              <div>
                <h3>รายชื่อสมาชิกสะสมแต้ม ({filteredMembers.length.toLocaleString()} คน)</h3>
                <p className="field-hint">
                  แสดงรูปโปรไฟล์และชื่อจากบัญชี LINE ของลูกค้าโดยตรง กดที่รายชื่อเพื่อดูประวัติและปรับแต้ม
                </p>
              </div>
            </div>

            {/* Search & Filter Toolbar */}
            <div className="loyalty-toolbar">
              <div className="loyalty-search-box">
                <Search size={17} className="loyalty-search-icon" />
                <input
                  type="search"
                  placeholder="ค้นหาชื่อ LINE ของลูกค้า หรือรหัสผู้ใช้..."
                  value={memberSearch}
                  onChange={(e) => {
                    setMemberSearch(e.target.value);
                    setMemberPage(1);
                  }}
                />
              </div>

              <div className="loyalty-filter-pills">
                <button
                  type="button"
                  className={`loyalty-filter-pill ${memberFilter === "all" ? "active" : ""}`}
                  onClick={() => {
                    setMemberFilter("all");
                    setMemberPage(1);
                  }}
                >
                  ทั้งหมด ({members.length})
                </button>
                <button
                  type="button"
                  className={`loyalty-filter-pill ${memberFilter === "has_coupon" ? "active" : ""}`}
                  onClick={() => {
                    setMemberFilter("has_coupon");
                    setMemberPage(1);
                  }}
                >
                  มีคูปองพร้อมใช้
                </button>
                <button
                  type="button"
                  className={`loyalty-filter-pill ${memberFilter === "near_reward" ? "active" : ""}`}
                  onClick={() => {
                    setMemberFilter("near_reward");
                    setMemberPage(1);
                  }}
                >
                  ใกล้ครบรับรางวัล
                </button>
                <button
                  type="button"
                  className={`loyalty-filter-pill ${memberFilter === "expiring_soon" ? "active" : ""}`}
                  onClick={() => {
                    setMemberFilter("expiring_soon");
                    setMemberPage(1);
                  }}
                >
                  แต้มใกล้หมดอายุ
                </button>
              </div>
            </div>

            {pagedMembers.length === 0 ? (
              <div className="loyalty-empty-box">
                {members.length === 0
                  ? "ยังไม่มีสมาชิกสะสมแต้มในร้านนี้ เมื่อลูกค้าเปิดบัตรหรือสแกน QR ข้อมูลโปรไฟล์ LINE จะแสดงที่นี่อัตโนมัติ"
                  : "ไม่พบรายชื่อลูกค้าที่ตรงกับเงื่อนไขการค้นหา"}
              </div>
            ) : (
              <div className="loyalty-clean-list">
                {pagedMembers.map((m) => {
                  const isLineAccount = m.lineUserId.startsWith("U");
                  return (
                    <div key={m.id} className="loyalty-clean-row">
                      <div
                        className="loyalty-member-cell clickable"
                        onClick={() => setSelectedMemberId(m.id)}
                      >
                        <LineProfileAvatar
                          pictureUrl={m.pictureUrl}
                          displayName={m.displayName}
                          lineUserId={m.lineUserId}
                          size={44}
                        />
                        <div className="loyalty-member-info">
                          <div className="loyalty-member-name-row">
                            <strong>{m.displayName}</strong>
                            {isLineAccount && <span className="loyalty-line-tag">LINE</span>}
                            {m.unclaimedCount > 0 && (
                              <span className="loyalty-ready-coupon-tag">
                                คูปองพร้อมใช้ {m.unclaimedCount} ใบ
                              </span>
                            )}
                          </div>
                          <span className="loyalty-member-meta">
                            แต้มปัจจุบัน:{" "}
                            <strong>
                              {m.stamps}/{config.stampsPerReward}
                            </strong>{" "}
                            · สะสมรวม {m.lifetimeStamps} แต้ม · หมดอายุ{" "}
                            {formatValidTillDate(m.expiresAt)}
                          </span>
                        </div>
                      </div>

                      <div className="loyalty-member-actions">
                        <button
                          type="button"
                          className="button ghost"
                          disabled={isPending || m.stamps <= 0}
                          onClick={() => handleQuickAdjustMember(m.id, -1)}
                          title="ลด 1 แต้ม"
                        >
                          <Minus size={14} /> 1
                        </button>
                        <button
                          type="button"
                          className="button ghost"
                          disabled={isPending}
                          onClick={() => handleQuickAdjustMember(m.id, 1)}
                          title="เพิ่ม 1 แต้ม"
                        >
                          <Plus size={14} /> 1
                        </button>
                        <button
                          type="button"
                          className="button ghost"
                          onClick={() => setSelectedMemberId(m.id)}
                        >
                          รายละเอียด
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Pagination Controls */}
            {totalMemberPages > 1 && (
              <div className="loyalty-pagination">
                <button
                  type="button"
                  className="button ghost"
                  disabled={safeMemberPage <= 1}
                  onClick={() => setMemberPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft size={16} /> ก่อนหน้า
                </button>
                <span>
                  หน้า {safeMemberPage} จาก {totalMemberPages}
                </span>
                <button
                  type="button"
                  className="button ghost"
                  disabled={safeMemberPage >= totalMemberPages}
                  onClick={() => setMemberPage((p) => Math.min(totalMemberPages, p + 1))}
                >
                  ถัดไป <ChevronRight size={16} />
                </button>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ============================================================
          TAB 4: คูปอง (Coupon Verification, Ready, Used & Logs)
          ============================================================ */}
      {activeTab === "coupons" && (
        <div className="loyalty-tab-content">
          {/* Instant Verify / Redeem Box */}
          <section className="panel loyalty-section-card loyalty-coupon-verify-panel">
            <div className="loyalty-section-head">
              <div>
                <h3>ตรวจสอบและยืนยันการใช้คูปองส่วนลด</h3>
                <p className="field-hint">
                  กรอกรหัสคูปอง (เช่น <code>GT-XXXXXX</code>) หรือชื่อ LINE ลูกค้า เพื่อตรวจสอบสถานะและกดยืนยันตัดสิทธิ์คูปอง
                </p>
              </div>
            </div>

            <form
              className="loyalty-coupon-verify-bar"
              onSubmit={(e) => {
                e.preventDefault();
                handleRedeemCouponCode(couponCodeInput);
              }}
            >
              <div className="loyalty-search-box" style={{ flex: 1 }}>
                <Ticket size={17} className="loyalty-search-icon" />
                <input
                  type="text"
                  placeholder="กรอกรหัสคูปอง เช่น GT-8F4K2A หรือพิมพ์ชื่อลูกค้า..."
                  value={couponCodeInput}
                  onChange={(e) => setCouponCodeInput(e.target.value)}
                />
              </div>
              <button
                type="submit"
                className="button primary"
                disabled={isPending || couponCodeInput.trim().length < 4}
              >
                <CheckCircle2 size={16} />
                ตรวจสอบ / ตัดสิทธิ์คูปอง
              </button>
            </form>

            {/* Live matching results while typing */}
            {couponCodeInput.trim().length >= 2 && (
              <div className="loyalty-live-coupon-matches">
                <span className="loyalty-sub-label">
                  ผลการค้นหาที่ตรงกัน ({matchingCoupons.length} รายการ)
                </span>
                {matchingCoupons.length === 0 ? (
                  <div className="loyalty-empty-box" style={{ padding: 12 }}>
                    ไม่พบคูปองที่ตรงกับ “{couponCodeInput}”
                  </div>
                ) : (
                  <div className="loyalty-clean-list">
                    {matchingCoupons.slice(0, 5).map((c) => (
                      <div key={c.id} className="loyalty-clean-row">
                        <div className="loyalty-member-cell">
                          <LineProfileAvatar
                            pictureUrl={c.pictureUrl}
                            displayName={c.displayName}
                            lineUserId={c.lineUserId}
                            size={38}
                          />
                          <div className="loyalty-member-info">
                            <strong>
                              #{c.code} · {c.displayName}
                            </strong>
                            <span className="loyalty-member-meta">
                              {c.title} · ออกเมื่อ {formatThaiDateTime(c.issuedAt)}
                            </span>
                          </div>
                        </div>
                        <div className="loyalty-member-actions">
                          {c.status === "unclaimed" ? (
                            <button
                              type="button"
                              className="button primary"
                              disabled={isPending}
                              onClick={() => handleRedeemCouponCode(c.code)}
                            >
                              ยืนยันใช้สิทธิ์ตอนนี้
                            </button>
                          ) : (
                            <span className="loyalty-coupon-status claimed">
                              ใช้แล้วเมื่อ {formatThaiDateTime(c.claimedAt)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Sub-tabs: Unclaimed / Claimed / Activity Logs */}
          <section className="panel loyalty-section-card">
            <div className="loyalty-sub-tabs">
              <button
                type="button"
                className={`loyalty-filter-pill ${couponSubTab === "unclaimed" ? "active" : ""}`}
                onClick={() => setCouponSubTab("unclaimed")}
              >
                คูปองพร้อมใช้ ({unclaimedCoupons.length})
              </button>
              <button
                type="button"
                className={`loyalty-filter-pill ${couponSubTab === "claimed" ? "active" : ""}`}
                onClick={() => setCouponSubTab("claimed")}
              >
                ใช้สิทธิ์แล้ว ({claimedCoupons.length})
              </button>
              <button
                type="button"
                className={`loyalty-filter-pill ${couponSubTab === "logs" ? "active" : ""}`}
                onClick={() => setCouponSubTab("logs")}
              >
                ประวัติการรับแต้มและคูปอง ({recentLogs.length})
              </button>
            </div>

            {couponSubTab === "unclaimed" && (
              <>
                {unclaimedCoupons.length === 0 ? (
                  <div className="loyalty-empty-box">ยังไม่มีคูปองที่รอใช้สิทธิ์ในขณะนี้</div>
                ) : (
                  <div className="loyalty-clean-list">
                    {unclaimedCoupons.map((c) => (
                      <div key={c.id} className="loyalty-clean-row">
                        <div className="loyalty-member-cell">
                          <LineProfileAvatar
                            pictureUrl={c.pictureUrl}
                            displayName={c.displayName}
                            lineUserId={c.lineUserId}
                            size={40}
                          />
                          <div className="loyalty-member-info">
                            <div className="loyalty-member-name-row">
                              <strong>{c.displayName}</strong>
                              <span className="loyalty-code-pill">#{c.code}</span>
                            </div>
                            <span className="loyalty-member-meta">
                              {c.title} · ออกคูปองเมื่อ {formatThaiDateTime(c.issuedAt)}
                            </span>
                          </div>
                        </div>
                        <div className="loyalty-member-actions">
                          <span className="loyalty-coupon-status unclaimed">ยังไม่ใช้สิทธิ์</span>
                          <button
                            type="button"
                            className="button primary"
                            disabled={isPending}
                            onClick={() => handleRedeemCouponCode(c.code)}
                          >
                            ตัดสิทธิ์ให้ลูกค้า
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {couponSubTab === "claimed" && (
              <>
                {claimedCoupons.length === 0 ? (
                  <div className="loyalty-empty-box">ยังไม่มีประวัติคูปองที่ถูกใช้สิทธิ์</div>
                ) : (
                  <div className="loyalty-clean-list">
                    {claimedCoupons.map((c) => (
                      <div key={c.id} className="loyalty-clean-row">
                        <div className="loyalty-member-cell">
                          <LineProfileAvatar
                            pictureUrl={c.pictureUrl}
                            displayName={c.displayName}
                            lineUserId={c.lineUserId}
                            size={40}
                          />
                          <div className="loyalty-member-info">
                            <div className="loyalty-member-name-row">
                              <strong>{c.displayName}</strong>
                              <span className="loyalty-code-pill muted">#{c.code}</span>
                            </div>
                            <span className="loyalty-member-meta">
                              {c.title} · ใช้สิทธิ์เมื่อ {formatThaiDateTime(c.claimedAt)}
                            </span>
                          </div>
                        </div>
                        <span className="loyalty-coupon-status claimed">ใช้สิทธิ์แล้ว</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {couponSubTab === "logs" && (
              <>
                {recentLogs.length === 0 ? (
                  <div className="loyalty-empty-box">ยังไม่มีประวัติการสะสมแต้ม</div>
                ) : (
                  <div className="loyalty-clean-list">
                    {recentLogs.slice(0, 60).map((log) => (
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
                              {log.note ? ` · ${log.note}` : ""} ·{" "}
                              {formatThaiDateTime(log.createdAt)}
                            </span>
                          </div>
                        </div>
                        <div className="loyalty-member-actions">
                          {log.pointsDelta !== 0 && (
                            <span
                              className={`loyalty-points-pill ${
                                log.pointsDelta > 0 ? "plus" : "minus"
                              }`}
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
              </>
            )}
          </section>
        </div>
      )}

      {/* ============================================================
          TAB 5: ตั้งค่าระบบ (Rules & Collapsible LINE OA Connection)
          ============================================================ */}
      {activeTab === "settings" && (
        <div className="loyalty-tab-content">
          <section className="panel loyalty-section-card">
            <div className="loyalty-section-head">
              <div>
                <h3>ตั้งค่ากติกาบัตรสะสมแต้มและการเชื่อมต่อ LINE</h3>
                <p className="field-hint">
                  กำหนดเงื่อนไขการสะสมแต้ม การแจ้งเตือน และการผูกบัญชี LINE OA ของร้าน {shopName}
                </p>
              </div>
            </div>

            <ActionForm
              action={saveLoyaltyConfigAction}
              submitLabel="บันทึกการตั้งค่าระบบสะสมแต้ม"
              pendingLabel="กำลังบันทึกการตั้งค่า…"
              className="settings-form"
              resetOnSuccess={false}
            >
              <input type="hidden" name="shop_secret" value={config.shopSecret} />
              <input type="hidden" name="webhook_secret" value={config.webhookSecret} />
              <input
                type="hidden"
                name="qr_tokens_json"
                value={JSON.stringify(config.qrTokens)}
              />

              <label className="checkbox-toggle-wrap">
                <input
                  type="checkbox"
                  name="loyalty_enabled"
                  defaultChecked={config.enabled}
                />
                <div>
                  <strong>เปิดใช้งานระบบบัตรสะสมแต้มสำหรับร้านนี้</strong>
                  <small className="muted-hint" style={{ display: "block", marginTop: "3px" }}>
                    เมื่อเปิดใช้งาน ลูกค้าสามารถสแกน QR Code เพื่อสะสมแต้มและกดใช้คูปองส่วนลดได้
                  </small>
                </div>
              </label>

              <div className="loyalty-admin-form-grid">
                <label>
                  ชื่อร้าน / ชื่อบนหัวบัตร
                  <input
                    name="card_title"
                    defaultValue={config.cardTitle}
                    placeholder="เช่น GaiTomNamPla"
                    maxLength={80}
                    required
                  />
                </label>
                <label>
                  ข้อความโปรโมชั่นหลักบนบัตร
                  <input
                    name="card_headline"
                    defaultValue={config.cardHeadline}
                    placeholder="เช่น สะสม 10 กล่อง ลด 50%"
                    maxLength={120}
                    required
                  />
                </label>
                <label>
                  ชื่อรางวัลเมื่อสะสมครบ
                  <input
                    name="reward_title"
                    defaultValue={config.rewardTitle}
                    placeholder="เช่น ลด 50% เมนูหลัก 1 กล่อง"
                    maxLength={120}
                    required
                  />
                </label>
                <label>
                  จำนวนแต้มที่ต้องสะสมต่อ 1 รางวัล
                  <input
                    name="stamps_per_reward"
                    type="number"
                    min={1}
                    max={30}
                    defaultValue={config.stampsPerReward}
                    required
                  />
                </label>
                <label>
                  อายุแต้มสะสม (เดือน นับจากสแกนครั้งล่าสุด)
                  <input
                    name="validity_months"
                    type="number"
                    min={1}
                    max={36}
                    defaultValue={config.validityMonths}
                    required
                  />
                </label>
                <label>
                  ระยะห่างขั้นต่ำในการสแกนซ้ำของคนเดิม (นาที)
                  <input
                    name="cooldown_minutes"
                    type="number"
                    min={0}
                    max={1440}
                    defaultValue={config.cooldownMinutes}
                    required
                  />
                </label>
              </div>

              <label>
                โหมดการส่งข้อความแจ้งเตือนเข้าแชท LINE (ช่วยควบคุมโควตารายเดือน)
                <select name="notify_mode" defaultValue={config.notifyMode || "all"}>
                  <option value="all">
                    ส่งแจ้งเตือนทุกครั้งที่สแกนรับแต้ม และเมื่อใช้คูปอง
                  </option>
                  <option value="reward_only">
                    ประหยัดโควตา: ส่งแจ้งเตือนเฉพาะเมื่อสะสมครบรับคูปองใหม่ และเมื่อใช้คูปอง
                  </option>
                  <option value="off">
                    ปิดการส่งข้อความ Push (ลูกค้าดูแต้มและคูปองบนหน้าบัตรได้ตามปกติ)
                  </option>
                </select>
              </label>

              <label>
                เงื่อนไขและกติกาที่แสดงบนหน้าบัตร (ขึ้นบรรทัดใหม่เพื่อแยกข้อ)
                <textarea
                  name="rules_text"
                  rows={5}
                  defaultValue={config.rulesText}
                  placeholder="ระบุกติกาการสะสมแต้มและการใช้คูปอง..."
                />
              </label>

              {/* Collapsible Advanced LINE OA & LIFF Configuration */}
              <div className="loyalty-line-config-box">
                <div className="loyalty-line-config-head">
                  <div>
                    <strong>การเชื่อมต่อ LINE OA และ LIFF (ขั้นสูง)</strong>
                    <span className="field-hint" style={{ display: "block", marginTop: 2 }}>
                      ใช้สำหรับดึงรูปโปรไฟล์ + ชื่อ LINE จริงของลูกค้า และส่งข้อความแจ้งเตือนเข้าแชทอัตโนมัติ
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="button ghost"
                      onClick={handleTestLineConnection}
                      disabled={isPending}
                    >
                      ทดสอบการเชื่อมต่อ LINE
                    </button>
                    <button
                      type="button"
                      className="button ghost"
                      onClick={() => setShowAdvancedLine((prev) => !prev)}
                    >
                      {showAdvancedLine ? "ซ่อนค่าเชื่อมต่อ" : "เปิดดู / แก้ไขค่าเชื่อมต่อ"}
                      <ChevronDown
                        size={15}
                        style={{
                          transform: showAdvancedLine ? "rotate(180deg)" : "none",
                          transition: "transform 0.15s ease",
                        }}
                      />
                    </button>
                  </div>
                </div>

                {showAdvancedLine && (
                  <div className="loyalty-advanced-body">
                    <div className="loyalty-admin-form-grid">
                      <label>
                        LIFF ID (สำหรับซิงก์รูปโปรไฟล์และชื่อ LINE ของลูกค้า)
                        <input
                          name="liff_id"
                          value={liffIdDraft}
                          onChange={(e) => setLiffIdDraft(e.target.value)}
                          placeholder="เช่น 2009769853-BWR6D81k"
                        />
                      </label>
                      <label>
                        LINE OA Basic ID
                        <input
                          name="bot_basic_id"
                          defaultValue={config.botBasicId}
                          placeholder="เช่น @gaitomnampla"
                        />
                      </label>
                      <label>
                        Messaging API Channel Secret
                        <input
                          name="channel_secret"
                          type="password"
                          defaultValue={config.channelSecret}
                          placeholder="Channel Secret จาก LINE Developers"
                          autoComplete="off"
                        />
                      </label>
                      <label>
                        Messaging API Channel Access Token (Long-lived)
                        <input
                          name="channel_access_token"
                          type="password"
                          value={accessTokenDraft}
                          onChange={(e) => setAccessTokenDraft(e.target.value)}
                          placeholder="Channel Access Token สำหรับส่งข้อความ Push"
                          autoComplete="off"
                        />
                      </label>
                    </div>

                    <div className="loyalty-copy-row" style={{ marginTop: 12 }}>
                      <div>
                        <span className="loyalty-copy-label">
                          1. LIFF Endpoint URL (นำไปวางในช่อง Endpoint URL ของ LIFF App และเปิด Scope: profile, openid)
                        </span>
                        <code className="loyalty-copy-code">{liffEndpointUrl}</code>
                      </div>
                      <button
                        type="button"
                        className="button ghost"
                        onClick={() => handleCopyText("liff-endpoint", liffEndpointUrl)}
                      >
                        {copiedKey === "liff-endpoint" ? <Check size={15} /> : <Copy size={15} />}
                        {copiedKey === "liff-endpoint" ? "คัดลอกแล้ว" : "คัดลอก"}
                      </button>
                    </div>

                    <div className="loyalty-copy-row">
                      <div>
                        <span className="loyalty-copy-label">
                          2. LINE Webhook URL (นำไปวางในช่อง Webhook URL ของ Messaging API)
                        </span>
                        <code className="loyalty-copy-code">{webhookUrl}</code>
                      </div>
                      <button
                        type="button"
                        className="button ghost"
                        onClick={() => handleCopyText("webhook", webhookUrl)}
                      >
                        {copiedKey === "webhook" ? <Check size={15} /> : <Copy size={15} />}
                        {copiedKey === "webhook" ? "คัดลอกแล้ว" : "คัดลอก"}
                      </button>
                    </div>

                    <button
                      type="button"
                      className="button ghost"
                      style={{ marginTop: 6 }}
                      onClick={() => setShowSetupGuide((prev) => !prev)}
                    >
                      {showSetupGuide ? "ซ่อนคู่มือการตั้งค่า LINE" : "ดูขั้นตอนการตั้งค่า LINE OA & LIFF"}
                    </button>

                    {showSetupGuide && (
                      <div className="loyalty-setup-guide" style={{ marginTop: 10 }}>
                        <ol>
                          <li>
                            เข้าเว็บ <strong>LINE Developers Console</strong> เลือก Provider ของร้าน
                            (แนะนำให้ทั้ง <strong>Messaging API</strong> และ <strong>LINE Login</strong>{" "}
                            อยู่ใน Provider เดียวกัน)
                          </li>
                          <li>
                            ในช่อง <strong>LINE Login</strong> สร้าง <strong>LIFF App</strong> ตั้งค่า{" "}
                            <code>Endpoint URL</code> เป็น <code>{liffEndpointUrl}</code> และติ๊กเลือก
                            Scope: <code>profile</code> และ <code>openid</code> เพื่อให้ระบบดึงชื่อและรูปโปรไฟล์ LINE ของลูกค้าได้
                          </li>
                          <li>
                            คัดลอกค่า <strong>LIFF ID</strong> และ <strong>Channel Access Token</strong>{" "}
                            มาวางในช่องด้านบน แล้วกดปุ่ม <strong>บันทึกการตั้งค่าระบบสะสมแต้ม</strong>
                          </li>
                        </ol>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </ActionForm>
          </section>
        </div>
      )}

      {/* ============================================================
          MODAL: Customer Detail, Coupons & Stamp Adjustment
          ============================================================ */}
      {selectedMember && (
        <div
          className="ig-sheet-backdrop"
          onClick={() => !isPending && setSelectedMemberId(null)}
        >
          <div
            className="ig-sheet-card loyalty-member-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ig-sheet-header">
              <strong>ข้อมูลสมาชิกสะสมแต้ม</strong>
              <button
                type="button"
                className="icon-button ig-sheet-close"
                onClick={() => setSelectedMemberId(null)}
                aria-label="ปิดหน้าต่าง"
              >
                <X size={18} />
              </button>
            </div>

            <div className="loyalty-member-modal-body">
              {/* Customer LINE Profile Header */}
              <div className="loyalty-member-profile-hero">
                <LineProfileAvatar
                  pictureUrl={selectedMember.pictureUrl}
                  displayName={selectedMember.displayName}
                  lineUserId={selectedMember.lineUserId}
                  size={64}
                />
                <div className="loyalty-member-profile-meta">
                  <div className="loyalty-member-name-row">
                    <h3>{selectedMember.displayName}</h3>
                    {selectedMember.lineUserId.startsWith("U") && (
                      <span className="loyalty-line-tag">เชื่อมต่อ LINE แล้ว</span>
                    )}
                  </div>
                  <span className="loyalty-member-meta">
                    รหัสอ้างอิง: <code>{selectedMember.lineUserId}</code>
                  </span>
                </div>
              </div>

              {/* Member Stamp Summary */}
              <div className="loyalty-member-stats-row">
                <div className="loyalty-member-stat-box">
                  <span>แต้มปัจจุบัน</span>
                  <strong>
                    {selectedMember.stamps} / {config.stampsPerReward}
                  </strong>
                </div>
                <div className="loyalty-member-stat-box">
                  <span>สะสมตลอดชีพ</span>
                  <strong>{selectedMember.lifetimeStamps} แต้ม</strong>
                </div>
                <div className="loyalty-member-stat-box">
                  <span>คูปองพร้อมใช้</span>
                  <strong>{selectedMember.unclaimedCount} ใบ</strong>
                </div>
                <div className="loyalty-member-stat-box">
                  <span>วันหมดอายุแต้ม</span>
                  <strong>{formatValidTillDate(selectedMember.expiresAt)}</strong>
                </div>
              </div>

              {/* Manual Stamp Adjustment Box */}
              <div className="loyalty-adjust-box">
                <strong>ปรับเพิ่ม / ลดแต้มของลูกค้า</strong>
                <div className="loyalty-adjust-quick-row">
                  {[1, 2, 3, 5].map((pts) => (
                    <button
                      key={`add-${pts}`}
                      type="button"
                      className="button ghost"
                      disabled={isPending}
                      onClick={() => handleQuickAdjustMember(selectedMember.id, pts)}
                    >
                      +{pts} แต้ม
                    </button>
                  ))}
                  {[-1, -2].map((pts) => (
                    <button
                      key={`sub-${pts}`}
                      type="button"
                      className="button ghost"
                      disabled={isPending || selectedMember.stamps <= 0}
                      onClick={() => handleQuickAdjustMember(selectedMember.id, pts)}
                    >
                      {pts} แต้ม
                    </button>
                  ))}
                </div>

                <form
                  className="loyalty-adjust-custom-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const n = Number(customDeltaInput);
                    if (Number.isFinite(n) && Math.round(n) !== 0) {
                      handleQuickAdjustMember(selectedMember.id, Math.round(n));
                    }
                  }}
                >
                  <input
                    type="number"
                    min={-30}
                    max={30}
                    value={customDeltaInput}
                    onChange={(e) => setCustomDeltaInput(e.target.value)}
                    placeholder="ระบุจำนวนแต้ม เช่น 4 หรือ -3"
                  />
                  <button type="submit" className="button primary" disabled={isPending}>
                    บันทึกการปรับแต้ม
                  </button>
                </form>
              </div>

              {/* Customer's Coupons */}
              <div className="loyalty-modal-section">
                <strong>คูปองของลูกค้ารายนี้ ({selectedMemberCoupons.length} ใบ)</strong>
                {selectedMemberCoupons.length === 0 ? (
                  <p className="field-hint">ยังไม่มีคูปองส่วนลด</p>
                ) : (
                  <div className="loyalty-clean-list">
                    {selectedMemberCoupons.map((c) => (
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
                            onClick={() => handleRedeemCouponCode(c.code)}
                          >
                            ตัดสิทธิ์คูปอง
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
                <strong>ประวัติล่าสุดของลูกค้ารายนี้</strong>
                {selectedMemberLogs.length === 0 ? (
                  <p className="field-hint">ยังไม่มีประวัติการทำรายการ</p>
                ) : (
                  <div className="loyalty-clean-list">
                    {selectedMemberLogs.slice(0, 10).map((log) => (
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
      )}
    </div>
  );
}
