"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Download, RefreshCw } from "lucide-react";
import { LOYALTY_POINT_TIERS, type LoyaltyConfig, buildLoyaltyClaimUrl } from "@/lib/loyalty";
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

  return (
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
                onClick={() => {
                  setConfirmResetQr(false);
                  onConfirmRegenerateQr();
                }}
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
  );
}
