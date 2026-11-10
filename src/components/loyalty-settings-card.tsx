"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Gift,
  QrCode,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";
import {
  adjustMemberStampsAction,
  regenerateLoyaltyQrTokensAction,
  saveLoyaltyConfigAction,
  verifyOrRedeemCouponByCodeAction,
  type LoyaltyAdminSnapshot,
} from "@/app/actions/loyalty";
import { ActionForm } from "@/components/action-form";
import {
  LOYALTY_POINT_TIERS,
  buildLoyaltyCardUrl,
  buildLoyaltyClaimUrl,
  formatThaiDateTime,
  formatValidTillDate,
} from "@/lib/loyalty";
import { generateQrMatrix, qrMatrixToSvgPath } from "@/lib/qr-code";

export interface LoyaltySettingsCardProps {
  shopName: string;
  snapshot: LoyaltyAdminSnapshot;
}

function renderQrCardPngDataUrl(params: {
  cardTitle: string;
  cardHeadline: string;
  points: number;
  qrUrl: string;
}): string {
  const matrix = generateQrMatrix(params.qrUrl);
  const canvas = document.createElement("canvas");
  const width = 900;
  const height = 1160;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // Background
  ctx.fillStyle = "#FA615B";
  ctx.fillRect(0, 0, width, height);

  // Main white/red card container
  const cardX = 56;
  const cardY = 56;
  const cardW = width - 112;
  const cardH = height - 112;
  const radius = 36;

  ctx.fillStyle = "#E62134";
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, radius);
  ctx.fill();

  // Header text
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "center";
  ctx.font = "bold 46px sans-serif";
  ctx.fillText(params.cardTitle, width / 2, cardY + 92);

  ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText(params.cardHeadline, width / 2, cardY + 144);

  // Points pill
  const pillW = 540;
  const pillH = 88;
  const pillX = (width - pillW) / 2;
  const pillY = cardY + 178;
  ctx.fillStyle = "#1FC879";
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillW, pillH, 44);
  ctx.fill();

  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 40px sans-serif";
  ctx.fillText(`เมนูหลัก ${params.points} กล่อง = รับ +${params.points} แต้ม`, width / 2, pillY + 57);

  // White QR container
  const qrBoxSize = 560;
  const qrBoxX = (width - qrBoxSize) / 2;
  const qrBoxY = pillY + 118;
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.roundRect(qrBoxX, qrBoxY, qrBoxSize, qrBoxSize, 28);
  ctx.fill();

  // Draw QR modules
  const quietZone = 3;
  const totalModules = matrix.length + quietZone * 2;
  const modulePx = Math.floor((qrBoxSize - 48) / totalModules);
  const actualQrPx = modulePx * totalModules;
  const startX = qrBoxX + Math.floor((qrBoxSize - actualQrPx) / 2);
  const startY = qrBoxY + Math.floor((qrBoxSize - actualQrPx) / 2);

  ctx.fillStyle = "#111111";
  for (let r = 0; r < matrix.length; r += 1) {
    for (let c = 0; c < matrix.length; c += 1) {
      if (matrix[r][c]) {
        ctx.fillRect(
          startX + (c + quietZone) * modulePx,
          startY + (r + quietZone) * modulePx,
          modulePx,
          modulePx,
        );
      }
    }
  }

  // Footer instructions
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText("สแกนด้วยกล้อง LINE เพื่อสะสมแต้มทันที", width / 2, qrBoxY + qrBoxSize + 64);

  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.font = "24px sans-serif";
  ctx.fillText("เมื่อสแกนแล้ว ระบบจะแจ้งเตือนแต้มสะสมในแชทร้านอัตโนมัติ", width / 2, qrBoxY + qrBoxSize + 106);

  return canvas.toDataURL("image/png");
}

export function LoyaltySettingsCard({ shopName, snapshot }: LoyaltySettingsCardProps) {
  const { config, persisted, isTableReady, members, recentCoupons, recentPushJobs = [] } = snapshot;
  const [origin, setOrigin] = useState("https://your-domain.vercel.app");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [showQrGallery, setShowQrGallery] = useState(config.enabled);
  const [downloadingAll, setDownloadingAll] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setOrigin(window.location.origin);
    }
  }, []);

  useEffect(() => {
    if (config.enabled) {
      setShowQrGallery(true);
    }
  }, [config.enabled]);

  const cardEndpointUrl = useMemo(
    () => `${origin}/loyalty?s=${encodeURIComponent(config.shopSecret)}`,
    [origin, config.shopSecret],
  );

  const customerShareUrl = useMemo(
    () => buildLoyaltyCardUrl(origin, config.shopSecret, config.liffId),
    [origin, config.shopSecret, config.liffId],
  );

  const webhookUrl = useMemo(
    () => `${origin}/api/line/webhook?w=${encodeURIComponent(config.webhookSecret)}`,
    [origin, config.webhookSecret],
  );

  const qrItems = useMemo(
    () =>
      LOYALTY_POINT_TIERS.map((points) => {
        const token = config.qrTokens[String(points)] ?? "";
        const url = buildLoyaltyClaimUrl(origin, config.shopSecret, points, token, config.liffId);
        const matrix = generateQrMatrix(url);
        const svg = qrMatrixToSvgPath(matrix, 2);
        return {
          points,
          token,
          url,
          svg,
        };
      }),
    [config.liffId, config.qrTokens, config.shopSecret, origin],
  );

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // Ignore clipboard failure
    }
  };

  const handleDownloadSingleQr = (points: number, url: string) => {
    const dataUrl = renderQrCardPngDataUrl({
      cardTitle: config.cardTitle,
      cardHeadline: config.cardHeadline,
      points,
      qrUrl: url,
    });
    if (!dataUrl) return;
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `QR-Stamp-${points}-Boxes.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadAllQr = async () => {
    setDownloadingAll(true);
    try {
      for (const item of qrItems) {
        handleDownloadSingleQr(item.points, item.url);
        await new Promise((r) => setTimeout(r, 220));
      }
    } finally {
      setDownloadingAll(false);
    }
  };

  return (
    <section className="panel settings-card loyalty-admin-card" style={{ gridColumn: "1 / -1" }}>
      <div className="loyalty-admin-header">
        <div>
          <span className="loyalty-admin-eyebrow">
            <Sparkles size={14} /> เฉพาะร้าน {shopName} (แยกอิสระจากร้านอื่นและบัญชีอื่น)
          </span>
          <h2>บัตรสะสมแต้ม LINE OA & คิวอาร์โค้ด 1–10 กล่อง ({config.cardTitle})</h2>
          <p className="field-hint" style={{ marginTop: 4 }}>
            ระบบบัตรสะสมแต้มหน้าตาเหมือน LINE Stamp Card เดิมทุกจุด พร้อมสร้างรูป QR Code ถาวรแยกตามจำนวนกล่อง (1–10 กล่อง) ให้เซฟเก็บไว้ส่งในแชท เมื่อลูกค้าสแกนหรือกดใช้คูปองจะมีข้อความแจ้งเตือนเด้งในแชท LINE OA ทันที
          </p>
        </div>
        <div className="loyalty-admin-header-actions">
          <a
            href={ cardEndpointUrl }
            target="_blank"
            rel="noreferrer"
            className="btn-secondary loyalty-preview-btn"
          >
            <ExternalLink size={15} /> เปิดดูหน้าบัตรสะสมแต้ม
          </a>
        </div>
      </div>

      {!isTableReady && (
        <div className="loyalty-admin-banner warn">
          <ShieldAlert size={18} />
          <div>
            <strong>ยังไม่ได้สร้างตารางเก็บแต้มในฐานข้อมูล Supabase</strong>
            <p>
              กรุณานำไฟล์ <code>supabase/migrations/202611110001_line_loyalty.sql</code> ไปรันใน Supabase SQL Editor 1 ครั้ง เพื่อให้ระบบบันทึกแต้มและคูปองของลูกค้าได้
            </p>
          </div>
        </div>
      )}

      {!persisted && (
        <div className="loyalty-admin-banner info">
          <Gift size={18} />
          <div>
            <strong>กดปุ่ม “บันทึกการตั้งค่าระบบสะสมแต้ม” ด้านล่าง 1 ครั้งเพื่อเปิดใช้งานสำหรับร้าน {shopName}</strong>
            <p>
              เมื่อกดบันทึกแล้ว รหัสร้านและ QR Code ทั้ง 1–10 กล่องของร้านนี้จะถูกล็อกเป็นรหัสประจำร้านถาวร สามารถดาวน์โหลดเก็บไว้ในอัลบั้มรูปส่งให้ลูกค้าได้ตลอด
            </p>
          </div>
        </div>
      )}

      <ActionForm
        action={saveLoyaltyConfigAction}
        submitLabel="บันทึกการตั้งค่าระบบสะสมแต้ม"
        pendingLabel="กำลังบันทึก..."
        className="settings-form"
        resetOnSuccess={false}
      >
        <input type="hidden" name="shop_secret" value={config.shopSecret} />
        <input type="hidden" name="webhook_secret" value={config.webhookSecret} />
        <input type="hidden" name="qr_tokens_json" value={JSON.stringify(config.qrTokens)} />

        <label className="checkbox-toggle-wrap">
          <input
            type="checkbox"
            name="loyalty_enabled"
            defaultChecked={config.enabled}
          />
          <div>
            <strong>เปิดใช้งานระบบบัตรสะสมแต้ม LINE OA สำหรับร้าน “{shopName}”</strong>
            <small className="muted-hint" style={{ display: "block", marginTop: "3px" }}>
              เปิดเฉพาะร้านที่ต้องการใช้งานเท่านั้น ร้านอื่นหรืออีเมลอื่นที่ไม่ได้ติ๊กเปิดจะไม่มีผลกระทบใดๆ
            </small>
          </div>
        </label>

        <div className="loyalty-admin-form-grid">
          <label>
            ชื่อบัตรสะสมแต้ม (แสดงบนหัวบัตรสีแดง)
            <input
              name="card_title"
              defaultValue={config.cardTitle}
              placeholder="เช่น GaiTomNamPla 🐔"
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
            ชื่อรางวัลคูปองส่วนลด (เมื่อสะสมครบ)
            <input
              name="reward_title"
              defaultValue={config.rewardTitle}
              placeholder="เช่น ลด 50% เมนูหลัก 1 กล่อง"
              maxLength={120}
              required
            />
          </label>

          <label>
            จำนวนแต้มต่อ 1 รางวัล (ช่องแสตมป์)
            <input
              name="stamps_per_reward"
              type="number"
              min={1}
              max={30}
              defaultValue={String(config.stampsPerReward)}
              required
            />
          </label>

          <label>
            อายุแต้มสะสม (เดือน นับจากครั้งล่าสุดที่ซื้อ)
            <input
              name="validity_months"
              type="number"
              min={1}
              max={36}
              defaultValue={String(config.validityMonths)}
              required
            />
          </label>

          <label>
            ป้องกันสแกน QR เดิมซ้ำภายใน (นาที)
            <input
              name="cooldown_minutes"
              type="number"
              min={0}
              max={1440}
              defaultValue={String(config.cooldownMinutes)}
              required
            />
            <small className="field-hint">
              แนะนำ 5 นาที เพื่อป้องกันลูกค้ากดสแกนรูป QR เดิมในแชทซ้ำติดกันหลายรอบ (ใส่ 0 หากต้องการทดสอบสแกนรัวๆ)
            </small>
          </label>
        </div>

        <label>
          เงื่อนไขการสะสมแต้ม (How this works — ขึ้นบรรทัดใหม่เพื่อแยกข้อ)
          <textarea
            name="rules_text"
            rows={5}
            defaultValue={config.rulesText}
            style={{ width: "100%", fontFamily: "inherit", padding: "10px 12px", borderRadius: 10 }}
          />
        </label>

        {/* LINE OA & LIFF Configuration */}
        <div className="loyalty-line-config-box">
          <div className="loyalty-line-config-head">
            <strong>🔗 เชื่อมต่อ LINE Official Account & LIFF (เพื่อให้แจ้งเตือนเด้งในแชทอัตโนมัติ)</strong>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowSetupGuide((prev) => !prev)}
            >
              {showSetupGuide ? "ซ่อนคู่มือการตั้งค่า LINE" : "ดูวิธีตั้งค่า LINE OA ทีละขั้นตอน"}
            </button>
          </div>

          {showSetupGuide && (
            <div className="loyalty-setup-guide">
              <ol>
                <li>
                  เข้าไปที่ <a href="https://developers.line.biz/console/" target="_blank" rel="noreferrer">LINE Developers Console</a> โดยตรวจสอบว่าทั้ง <strong>Messaging API Channel</strong> (ของ LINE OA ร้าน) และ <strong>LINE Login Channel</strong> (สำหรับ LIFF) อยู่ภายใต้ <strong>Provider เดียวกัน</strong> เพื่อให้รหัสลูกค้า (<code>userId</code>) ตรงกัน
                </li>
                <li>
                  ใน Channel <strong>LINE Login</strong> แท็บ Basic settings ให้ผูก <strong>Linked OA</strong> เข้ากับ LINE OA ของร้าน และในแท็บ <strong>LIFF</strong> กด Add ตั้งขนาดเป็น <strong>Full</strong>, ใส่ <strong>Endpoint URL</strong> ด้านล่าง, เลือก Scope เฉพาะ <code>profile</code> และ <code>openid</code> และตั้งค่า <strong>Add friend option</strong> เป็น <strong><code>On (Normal)</code></strong> (เพื่อให้ลูกค้าที่ยังไม่เป็นเพื่อนกดเพิ่มเพื่อน OA ตอนเปิดบัตรได้ทันที)
                </li>
                <li>
                  ใน Channel <strong>Messaging API</strong> แท็บ Messaging API คัดลอก <strong>Channel access token (long-lived)</strong> มาใส่ในช่องด้านล่าง (ระบบจะเข้ารหัส AES-256-GCM เก็บไว้อย่างปลอดภัย หากเคยออก Token ก่อนอัปเดต SQL แนะนำให้กด Reissue ออก Token ใหม่ 1 ครั้ง)
                </li>
                <li>
                  <strong>เรื่องโควตาข้อความ LINE OA:</strong> การส่งข้อความทักหาลูกค้าอัตโนมัติ (Push Message) จะนับรวมในโควตาข้อความรายเดือนของ LINE OA (แพ็กเกจฟรีได้ 300 ข้อความ/เดือน) สามารถเลือกโหมดประหยัดโควตาด้านล่างได้ ส่วนการตอบกลับเมื่อลูกค้าพิมพ์ <code>เช็คแต้ม</code> ผ่าน Webhook (Reply Message) ส่งฟรีไม่เสียโควตา
                </li>
              </ol>
            </div>
          )}

          <div className="loyalty-copy-row">
            <div>
              <span className="loyalty-copy-label">1. LIFF Endpoint URL (นำไปวางในช่อง Endpoint URL ของ LINE LIFF)</span>
              <code className="loyalty-copy-code">{cardEndpointUrl}</code>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handleCopy("endpoint", cardEndpointUrl)}
            >
              {copiedKey === "endpoint" ? <Check size={15} /> : <Copy size={15} />}
              {copiedKey === "endpoint" ? "คัดลอกแล้ว" : "คัดลอกลิงก์"}
            </button>
          </div>

          <div className="loyalty-copy-row">
            <div>
              <span className="loyalty-copy-label">2. ลิงก์หน้าบัตรสะสมแต้มสำหรับติดปุ่ม Rich Menu ใน LINE OA</span>
              <code className="loyalty-copy-code">{customerShareUrl}</code>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handleCopy("share", customerShareUrl)}
            >
              {copiedKey === "share" ? <Check size={15} /> : <Copy size={15} />}
              {copiedKey === "share" ? "คัดลอกแล้ว" : "คัดลอกลิงก์"}
            </button>
          </div>

          <div className="loyalty-copy-row">
            <div>
              <span className="loyalty-copy-label">3. LINE Messaging API Webhook URL (ทางเลือกเสริม — ตอบกลับอัตโนมัติเมื่อลูกค้าพิมพ์ “เช็คแต้ม”)</span>
              <code className="loyalty-copy-code">{webhookUrl}</code>
            </div>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => handleCopy("webhook", webhookUrl)}
            >
              {copiedKey === "webhook" ? <Check size={15} /> : <Copy size={15} />}
              {copiedKey === "webhook" ? "คัดลอกแล้ว" : "คัดลอกลิงก์"}
            </button>
          </div>

          <div className="loyalty-admin-form-grid" style={{ marginTop: 12 }}>
            <label>
              LIFF ID (จาก LINE Developers Console)
              <input
                name="liff_id"
                defaultValue={config.liffId}
                placeholder="เช่น 2006123456-AbCdEfGh"
              />
            </label>

            <label>
              LINE OA Basic ID (เช่น @gaitomnampla)
              <input
                name="bot_basic_id"
                defaultValue={config.botBasicId}
                placeholder="เช่น @gaitomnampla"
              />
            </label>

            <label>
              Messaging API Channel Secret (ทางเลือกเสริม)
              <input
                name="channel_secret"
                type="password"
                defaultValue={config.channelSecret}
                placeholder="ใส่เมื่อต้องการเปิดใช้ Webhook ตอบกลับอัตโนมัติ"
              />
            </label>

            <label>
              Messaging API Channel Access Token (เข้ารหัส AES-256-GCM บนเซิร์ฟเวอร์)
              <input
                name="channel_access_token"
                type="password"
                defaultValue={config.channelAccessToken}
                placeholder="วาง Channel access token (long-lived) ของ LINE OA"
              />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              โหมดการส่งข้อความแจ้งเตือนเข้าแชท LINE OA (จัดการโควตาข้อความรายเดือน)
              <select name="notify_mode" defaultValue={config.notifyMode || "all"}>
                <option value="all">
                  แจ้งเตือนทุกครั้งที่สแกนรับแต้ม + ตอนใช้คูปอง (ใช้โควตา Push 1 ข้อความ/การสแกน)
                </option>
                <option value="reward_only">
                  ประหยัดโควตาได้สูงสุดประมาณ 10 เท่า — แจ้งเตือนเฉพาะตอนสะสมครบรับคูปองส่วนลด + ตอนกดใช้คูปอง
                </option>
                <option value="off">
                  ปิดการส่ง Push อัตโนมัติ (ลูกค้าดูแต้มบนหน้าบัตร + พิมพ์ “เช็คแต้ม” ฟรีผ่าน Webhook)
                </option>
              </select>
            </label>
          </div>
        </div>
      </ActionForm>

      {/* 1-10 Boxes Permanent QR Code Gallery */}
      <div className="loyalty-qr-section">
        <div className="loyalty-qr-header">
          <div>
            <h3>
              <QrCode size={18} /> คิวอาร์โค้ดสะสมแต้มถาวรแยกตามจำนวนกล่อง (1–10 กล่อง)
            </h3>
            <p className="field-hint">
              คิวอาร์โค้ดแต่ละใบใช้รหัสลับเฉพาะตัว (ลูกค้าแก้ตัวเลขข้ามกล่องเองไม่ได้) คุณสามารถกดดาวน์โหลดทั้ง 10 รูปเก็บไว้ในอัลบั้มมือถือ เพื่อส่งให้ลูกค้าตามจำนวนกล่องที่สั่งได้เลย
            </p>
          </div>
          <div className="loyalty-qr-header-btns">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowQrGallery((prev) => !prev)}
            >
              {showQrGallery ? "ซ่อนคิวอาร์โค้ด 1–10 กล่อง" : "แสดงคิวอาร์โค้ด 1–10 กล่อง"}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleDownloadAllQr}
              disabled={downloadingAll}
            >
              <Download size={16} />
              {downloadingAll ? "กำลังดาวน์โหลด..." : "ดาวน์โหลดครบทั้ง 10 รูป (PNG)"}
            </button>
          </div>
        </div>

        {showQrGallery && (
          <>
            <div className="loyalty-qr-grid">
              {qrItems.map((item) => (
                <div key={item.points} className="loyalty-qr-card">
                  <div className="loyalty-qr-card-top">
                    <span className="loyalty-qr-box-badge">{item.points} กล่อง</span>
                    <span className="loyalty-qr-point-badge">+{item.points} แต้ม</span>
                  </div>
                  <div className="loyalty-qr-svg-wrap">
                    <svg
                      viewBox={`0 0 ${item.svg.viewBoxSize} ${item.svg.viewBoxSize}`}
                      className="loyalty-qr-svg"
                      shapeRendering="crispEdges"
                    >
                      <rect width={item.svg.viewBoxSize} height={item.svg.viewBoxSize} fill="#ffffff" />
                      <path d={item.svg.pathData} fill="#111111" />
                    </svg>
                  </div>
                  <div className="loyalty-qr-card-actions">
                    <button
                      type="button"
                      className="btn-primary loyalty-qr-dl-btn"
                      onClick={() => handleDownloadSingleQr(item.points, item.url)}
                    >
                      <Download size={14} /> เซฟรูป {item.points} กล่อง
                    </button>
                    <div className="loyalty-qr-sub-actions">
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => handleCopy(`qr-${item.points}`, item.url)}
                      >
                        {copiedKey === `qr-${item.points}` ? "คัดลอกแล้ว" : "คัดลอกลิงก์"}
                      </button>
                      <a
                        href={`/loyalty?s=${encodeURIComponent(config.shopSecret)}&p=${item.points}&t=${encodeURIComponent(item.token)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-secondary"
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
                <strong>ต้องการเปลี่ยนรหัส QR Code ใหม่ทั้งหมด?</strong>
                <p className="field-hint">
                  หากรูป QR Code เดิมหลุดไปภายนอก สามารถกดรีเซ็ตเพื่อออกรหัสชุดใหม่ได้ทันที (แต้มสะสมและคูปองของลูกค้าทุกคนยังอยู่ครบเหมือนเดิม)
                </p>
              </div>
              <ActionForm
                action={regenerateLoyaltyQrTokensAction}
                submitLabel="รีเซ็ตรหัส QR ทั้ง 10 ใบใหม่"
                pendingLabel="กำลังรีเซ็ต..."
                resetOnSuccess={false}
              >
                <span />
              </ActionForm>
            </div>
          </>
        )}
      </div>

      {/* Customer Stamp & Coupon List */}
      <div className="loyalty-members-section">
        <div className="loyalty-qr-header">
          <div>
            <h3>
              <Users size={18} /> รายชื่อลูกค้าที่สะสมแต้ม ({members.length} คน)
            </h3>
            <p className="field-hint">
              สามารถกดปุ่ม <strong>+1 / +5 / -1 แต้ม</strong> เพื่อโอนแต้มเดิมจากบัตรเก่ามาให้ลูกค้า หรือปรับปรุงแต้มได้ทันที
            </p>
          </div>
        </div>

        {members.length === 0 ? (
          <div className="loyalty-empty-box">
            ยังไม่มีลูกค้าสแกนสะสมแต้มในร้านนี้ (คุณสามารถกดปุ่ม “ทดสอบสแกน” บนการ์ด QR ด้านบนเพื่อทดลองสะสมแต้มและตัดคูปองได้เลย)
          </div>
        ) : (
          <div className="loyalty-members-list">
            {members.map((m) => (
              <div key={m.id} className="loyalty-member-row">
                <div className="loyalty-member-info">
                  <strong>{m.displayName}</strong>
                  <span className="loyalty-member-meta">
                    แต้มปัจจุบัน: <b>{m.stamps} / {config.stampsPerReward}</b> · สะสมทั้งหมด {m.lifetimeStamps} แต้ม · หมดอายุ {formatValidTillDate(m.expiresAt)}
                  </span>
                  <span className="loyalty-member-coupons">
                    คูปองพร้อมใช้: <b>{m.unclaimedCount} ใบ</b> · ใช้แล้ว: {m.claimedCount} ใบ
                  </span>
                </div>
                <div className="loyalty-member-actions">
                  <ActionForm
                    action={adjustMemberStampsAction}
                    submitLabel="+1 แต้ม"
                    pendingLabel="..."
                    resetOnSuccess={false}
                  >
                    <input type="hidden" name="member_id" value={m.id} />
                    <input type="hidden" name="delta_stamps" value="1" />
                  </ActionForm>
                  <ActionForm
                    action={adjustMemberStampsAction}
                    submitLabel="+5 แต้ม"
                    pendingLabel="..."
                    resetOnSuccess={false}
                  >
                    <input type="hidden" name="member_id" value={m.id} />
                    <input type="hidden" name="delta_stamps" value="5" />
                  </ActionForm>
                  <ActionForm
                    action={adjustMemberStampsAction}
                    submitLabel="-1 แต้ม"
                    pendingLabel="..."
                    resetOnSuccess={false}
                  >
                    <input type="hidden" name="member_id" value={m.id} />
                    <input type="hidden" name="delta_stamps" value="-1" />
                  </ActionForm>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 22, paddingTop: 16, borderTop: "1px dashed rgba(120, 95, 70, 0.25)" }}>
          <h4 style={{ fontSize: "0.95rem", marginBottom: 6 }}>
            <RefreshCw size={14} style={{ verticalAlign: "middle", marginRight: 6 }} />
            ตรวจสอบ / ยืนยันการตัดสิทธิ์คูปองส่วนลดหน้าร้าน (#GT-XXXXXX)
          </h4>
          <p className="field-hint" style={{ marginBottom: 10 }}>
            เมื่อลูกค้าส่งแคปหน้าจอหรือแจ้งรหัสคูปองในแชท ร้านค้าสามารถกรอกรหัสคูปองด้านล่าง (หรือกดปุ่มยืนยันในตาราง) เพื่อตรวจสอบและตัดสิทธิ์คูปองได้ทันที ป้องกันการนำภาพแคปเก่ามาใช้ซ้ำ
          </p>
          <ActionForm
            action={verifyOrRedeemCouponByCodeAction}
            submitLabel="ตรวจสอบ & ยืนยันใช้คูปอง"
            pendingLabel="กำลังตรวจสอบ..."
            resetOnSuccess={true}
            className="loyalty-coupon-verify-form"
          >
            <input
              type="text"
              name="coupon_code"
              placeholder="กรอกรหัสคูปอง เช่น GT-8899AA หรือ #GT-8899AA"
              maxLength={24}
              style={{ maxWidth: 320 }}
              required
            />
          </ActionForm>
        </div>

        {recentCoupons.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h4 style={{ fontSize: "0.95rem", marginBottom: 8 }}>
              ประวัติคูปองส่วนลดล่าสุด ({recentCoupons.length} รายการ)
            </h4>
            <div className="loyalty-members-list">
              {recentCoupons.slice(0, 12).map((c) => (
                <div key={c.id} className="loyalty-member-row">
                  <div className="loyalty-member-info">
                    <strong>
                      #{c.code} — {c.title} ({c.displayName})
                    </strong>
                    <span className="loyalty-member-meta">
                      ออกคูปองเมื่อ {formatThaiDateTime(c.issuedAt)}
                      {c.claimedAt ? ` · กดใช้สิทธิ์เมื่อ ${formatThaiDateTime(c.claimedAt)}` : ""}
                    </span>
                  </div>
                  <div className="loyalty-member-actions">
                    {c.status === "unclaimed" && (
                      <ActionForm
                        action={verifyOrRedeemCouponByCodeAction}
                        submitLabel="ร้านกดตัดสิทธิ์"
                        pendingLabel="..."
                        resetOnSuccess={false}
                      >
                        <input type="hidden" name="coupon_code" value={c.code} />
                      </ActionForm>
                    )}
                    <span className={`loyalty-coupon-status ${c.status}`}>
                      {c.status === "claimed" ? "✓ ใช้สิทธิ์แล้ว" : "ยังไม่ใช้สิทธิ์"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {recentPushJobs.length > 0 && (
          <div style={{ marginTop: 18 }}>
            <h4 style={{ fontSize: "0.95rem", marginBottom: 8 }}>
              สถานะคิวส่งข้อความแจ้งเตือน LINE OA เบื้องหลังล่าสุด ({recentPushJobs.length} รายการ)
            </h4>
            <div className="loyalty-members-list">
              {recentPushJobs.slice(0, 6).map((job) => (
                <div key={job.id} className="loyalty-member-row">
                  <div className="loyalty-member-info">
                    <strong>
                      {job.eventType === "coupon_redeem" ? "🎟️ แจ้งใช้คูปองส่วนลด" : "🐔 แจ้งสะสมแต้ม QR"}
                    </strong>
                    <span className="loyalty-member-meta">
                      สร้างเมื่อ {formatThaiDateTime(job.createdAt)} · พยายามส่ง {job.attempts} ครั้ง
                      {job.lastError ? ` · สาเหตุ: ${job.lastError}` : ""}
                    </span>
                  </div>
                  <span
                    className={`loyalty-coupon-status ${
                      job.status === "sent" ? "claimed" : "unclaimed"
                    }`}
                  >
                    {job.status === "sent"
                      ? "✓ ส่งสำเร็จ"
                      : job.status === "pending" || job.status === "processing"
                        ? "⏳ รอส่ง/กำลังส่ง"
                        : job.status === "failed_quota"
                          ? "⚠️ โควตาเต็ม (429)"
                          : job.status === "failed_auth"
                            ? "⚠️ Token ผิด (401)"
                            : "⚠️ ส่งไม่สำเร็จ"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
