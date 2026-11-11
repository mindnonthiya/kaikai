"use client";

import { useState } from "react";
import { Check, ChevronDown, Copy, ShieldCheck } from "lucide-react";
import { saveLoyaltyConfigAction } from "@/app/actions/loyalty";
import { ActionForm } from "@/components/action-form";
import type { LoyaltyConfig } from "@/lib/loyalty";

export function RewardsSettingsTab({
  shopName,
  config,
  liffIdDraft,
  onChangeLiffIdDraft,
  liffEndpointUrl,
  webhookUrl,
  copiedKey,
  isPending,
  onCopyText,
  onTestLineConnection,
}: {
  shopName: string;
  config: LoyaltyConfig;
  liffIdDraft: string;
  onChangeLiffIdDraft: (val: string) => void;
  liffEndpointUrl: string;
  webhookUrl: string;
  copiedKey: string | null;
  isPending: boolean;
  onCopyText: (key: string, textToCopy: string) => void;
  onTestLineConnection: (draftToken: string) => void;
}) {
  const hasStoredSecret = Boolean(config.hasChannelSecret || config.channelSecret);
  const hasStoredToken = Boolean(config.hasChannelAccessToken || config.channelAccessToken);

  const [showAdvancedLine, setShowAdvancedLine] = useState(
    !config.liffId || !hasStoredToken,
  );
  const [showSetupGuide, setShowSetupGuide] = useState(false);

  // Never prefill decrypted secrets in the browser; keep inputs empty unless typing a replacement
  const [channelSecretDraft, setChannelSecretDraft] = useState("");
  const [accessTokenDraft, setAccessTokenDraft] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [clearToken, setClearToken] = useState(false);

  return (
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
          <input
            type="hidden"
            name="clear_channel_secret"
            value={clearSecret ? "true" : "false"}
          />
          <input
            type="hidden"
            name="clear_channel_access_token"
            value={clearToken ? "true" : "false"}
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
                  onClick={() => onTestLineConnection(accessTokenDraft)}
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
                      onChange={(e) => onChangeLiffIdDraft(e.target.value)}
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
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <span>Messaging API Channel Secret</span>
                      {hasStoredSecret && !clearSecret && (
                        <span className="loyalty-line-tag" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <ShieldCheck size={12} /> ตั้งค่าแล้วบนเซิร์ฟเวอร์
                        </span>
                      )}
                    </span>
                    <input
                      name="channel_secret"
                      type="password"
                      value={channelSecretDraft}
                      onChange={(e) => {
                        setChannelSecretDraft(e.target.value);
                        if (e.target.value) setClearSecret(false);
                      }}
                      placeholder={
                        hasStoredSecret && !clearSecret
                          ? "ตั้งค่าแล้ว (เว้นว่างไว้เพื่อใช้รหัสเดิม หรือพิมพ์ใหม่เพื่อเปลี่ยน)"
                          : "Channel Secret จาก LINE Developers"
                      }
                      autoComplete="new-password"
                    />
                    {hasStoredSecret && (
                      <small className="field-hint" style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                        <span>
                          {clearSecret
                            ? "จะลบรหัสเดิมเมื่อกดบันทึก"
                            : "ระบบไม่ส่งรหัสจริงมาที่เบราว์เซอร์เพื่อความปลอดภัย"}
                        </span>
                        <button
                          type="button"
                          className="link-button"
                          style={{ fontSize: 11.5 }}
                          onClick={() => setClearSecret((v) => !v)}
                        >
                          {clearSecret ? "ยกเลิกการลบ" : "ลบรหัสเดิม"}
                        </button>
                      </small>
                    )}
                  </label>
                  <label>
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      <span>Messaging API Channel Access Token</span>
                      {hasStoredToken && !clearToken && (
                        <span className="loyalty-line-tag" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <ShieldCheck size={12} /> ตั้งค่าแล้วบนเซิร์ฟเวอร์
                        </span>
                      )}
                    </span>
                    <input
                      name="channel_access_token"
                      type="password"
                      value={accessTokenDraft}
                      onChange={(e) => {
                        setAccessTokenDraft(e.target.value);
                        if (e.target.value) setClearToken(false);
                      }}
                      placeholder={
                        hasStoredToken && !clearToken
                          ? "ตั้งค่าแล้ว (เว้นว่างไว้เพื่อใช้ Token เดิม หรือพิมพ์ใหม่เพื่อเปลี่ยน)"
                          : "Channel Access Token สำหรับส่งข้อความ Push"
                      }
                      autoComplete="new-password"
                    />
                    {hasStoredToken && (
                      <small className="field-hint" style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                        <span>
                          {clearToken
                            ? "จะลบ Token เดิมเมื่อกดบันทึก"
                            : "กด “ทดสอบการเชื่อมต่อ LINE” ได้ทันทีโดยใช้รหัสบนเซิร์ฟเวอร์"}
                        </span>
                        <button
                          type="button"
                          className="link-button"
                          style={{ fontSize: 11.5 }}
                          onClick={() => setClearToken((v) => !v)}
                        >
                          {clearToken ? "ยกเลิกการลบ" : "ลบ Token เดิม"}
                        </button>
                      </small>
                    )}
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
                    onClick={() => onCopyText("liff-endpoint", liffEndpointUrl)}
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
                    onClick={() => onCopyText("webhook", webhookUrl)}
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
  );
}
