"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Download, RefreshCw } from "lucide-react";
import {
  LOYALTY_POINT_TIERS,
  type LoyaltyConfig,
  buildLoyaltyClaimUrl,
  stripEmoji,
} from "@/lib/loyalty";
import { generateQrMatrix, qrMatrixToSvgPath } from "@/lib/qr-code";

export function RewardsQrTab({
  shopName,
  config,
  origin,
  liffIdDraft,
  copiedKey,
  isPending,
  onCopyText,
  onConfirmRegenerateQr,
}: {
  shopName: string;
  config: LoyaltyConfig;
  origin: string;
  liffIdDraft: string;
  copiedKey: string | null;
  isPending: boolean;
  onCopyText: (key: string, textToCopy: string) => void;
  onConfirmRegenerateQr: () => void;
}) {
  const [confirmResetQr, setConfirmResetQr] = useState(false);

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

    const cleanShopTitle = stripEmoji(config.cardTitle || shopName) || shopName;
    const cleanReward = stripEmoji(config.rewardTitle);

    // Outer Rich Menu Coral Background
    ctx.fillStyle = "#FA5B5A";
    ctx.fillRect(0, 0, width, height);

    // Inner Card Panel (#FCE254 top + #FFFDF7 body with #2E231E Espresso border)
    ctx.fillStyle = "#FFFDF7";
    ctx.strokeStyle = "#2E231E";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.roundRect(54, 54, width - 108, height - 108, 40);
    ctx.fill();
    ctx.stroke();

    // Butter-Yellow Top Header Band inside Card
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(58, 58, width - 116, 250, [36, 36, 0, 0]);
    ctx.fillStyle = "#FCE254";
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "#2E231E";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(56, 308);
    ctx.lineTo(width - 56, 308);
    ctx.stroke();

    ctx.fillStyle = "#2E231E";
    ctx.font = "800 44px -apple-system, BlinkMacSystemFont, 'Noto Sans Thai', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(cleanShopTitle, width / 2, 138);

    ctx.fillStyle = "#5C4738";
    ctx.font = "700 32px -apple-system, BlinkMacSystemFont, 'Noto Sans Thai', sans-serif";
    ctx.fillText(`คิวอาร์โค้ดสะสมแต้มสำหรับ ${points} กล่อง`, width / 2, 194);

    // Crisp White Pill Badge with Espresso Border (matches Rich Menu pill labels)
    ctx.fillStyle = "#FFFFFF";
    ctx.strokeStyle = "#2E231E";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.roundRect(width / 2 - 175, 220, 350, 62, 31);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#2E231E";
    ctx.font = "800 30px -apple-system, BlinkMacSystemFont, 'Noto Sans Thai', sans-serif";
    ctx.fillText(`สแกนรับ +${points} แต้ม`, width / 2, 261);

    const qrBoxSize = 570;
    const qrStartX = (width - qrBoxSize) / 2;
    const qrStartY = 345;
    const modulePx = qrBoxSize / qrSize;

    ctx.fillStyle = "#2E231E";
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

    ctx.fillStyle = "#2E231E";
    ctx.font = "700 26px -apple-system, BlinkMacSystemFont, 'Noto Sans Thai', sans-serif";
    ctx.fillText(
      `สะสมครบ ${config.stampsPerReward} แต้ม รับสิทธิ์ “${cleanReward}”`,
      width / 2,
      978,
    );

    ctx.fillStyle = "#6B574C";
    ctx.font = "500 22px -apple-system, BlinkMacSystemFont, 'Noto Sans Thai', sans-serif";
    ctx.fillText("สแกนผ่านกล้อง LINE เพื่อรับแต้มสะสม", width / 2, 1020);

    const dataUrl = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `qr-${points}-box.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="loyalty-tab-content">
      <section className="panel loyalty-section-card">
        <div className="loyalty-section-head">
          <div>
            <h3>QR โค้ดสะสมแต้ม (1–10 กล่อง)</h3>
            <p className="field-hint">บันทึกรูปเก็บไว้ส่งให้ลูกค้าสแกนตามจำนวนกล่องที่ซื้อ</p>
          </div>
        </div>

        <div className="loyalty-qr-grid">
          {qrCards.map((item) => (
            <div key={item.points} className="loyalty-qr-card">
              <div className="loyalty-qr-card-top">
                <span className="loyalty-qr-box-badge">{item.points} กล่อง</span>
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
                  ดาวน์โหลด PNG
                </button>
                <div className="loyalty-qr-sub-actions">
                  <button
                    type="button"
                    className="button ghost"
                    onClick={() => onCopyText(`qr-${item.points}`, item.url)}
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
                    เปิดดู
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="loyalty-qr-rotate-bar">
          <div>
            <strong>รีเซ็ตรหัส QR ใหม่ทั้งหมด</strong>
            <p className="field-hint" style={{ margin: "2px 0 0" }}>
              ใช้กรณีรูป QR เดิมหลุด (แต้มและคูปองลูกค้ายังอยู่ครบ)
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
              รีเซ็ตรหัส QR
            </button>
          ) : (
            <div className="loyalty-confirm-inline">
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setConfirmResetQr(false);
                  onConfirmRegenerateQr();
                }}
                disabled={isPending}
              >
                ยืนยันรีเซ็ต
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
  );
}
