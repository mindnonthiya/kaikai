"use client";

import { CheckCircle2, Download, Share, Smartphone, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((fn) => fn());
}

function usePwaState() {
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [canInstallPrompt, setCanInstallPrompt] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const checkStandalone = () => {
      const standaloneMatch = window.matchMedia("(display-mode: standalone)").matches;
      const iosStandalone = Boolean(
        (window.navigator as Navigator & { standalone?: boolean }).standalone,
      );
      setIsStandalone(standaloneMatch || iosStandalone);
    };

    checkStandalone();

    const ua = window.navigator.userAgent || "";
    const iosDevice =
      /iPad|iPhone|iPod/.test(ua) ||
      (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
    setIsIos(iosDevice);
    setCanInstallPrompt(Boolean(deferredInstallPrompt));

    const mediaQuery = window.matchMedia("(display-mode: standalone)");
    const handleMediaChange = () => checkStandalone();
    mediaQuery.addEventListener?.("change", handleMediaChange);

    const handlePromptUpdate = () => {
      setCanInstallPrompt(Boolean(deferredInstallPrompt));
      checkStandalone();
    };
    listeners.add(handlePromptUpdate);

    return () => {
      mediaQuery.removeEventListener?.("change", handleMediaChange);
      listeners.delete(handlePromptUpdate);
    };
  }, []);

  async function triggerInstall() {
    if (!deferredInstallPrompt) return false;
    try {
      await deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === "accepted") {
        deferredInstallPrompt = null;
        notifyListeners();
        return true;
      }
    } catch {
      // Ignore prompt errors
    }
    return false;
  }

  return { isStandalone, isIos, canInstallPrompt, triggerInstall };
}

export function PwaServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredInstallPrompt = e as BeforeInstallPromptEvent;
      notifyListeners();
    };

    const handleAppInstalled = () => {
      deferredInstallPrompt = null;
      notifyListeners();
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch(() => {
          // Non-blocking in dev or restricted contexts
        });
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  return null;
}

export function PwaDrawerInstallButton({ onNavigate }: { onNavigate?: () => void }) {
  const { isStandalone, isIos, canInstallPrompt, triggerInstall } = usePwaState();
  const [showIosGuide, setShowIosGuide] = useState(false);

  if (isStandalone) return null;

  async function handleClick() {
    if (canInstallPrompt) {
      const installed = await triggerInstall();
      if (installed) onNavigate?.();
      return;
    }
    setShowIosGuide(true);
  }

  return (
    <>
      <button
        type="button"
        className="side-nav-install"
        onClick={handleClick}
        aria-label="เพิ่มลงหน้าจอหลัก"
      >
        <Download size={20} strokeWidth={2} />
        <span>เพิ่มลงหน้าจอหลัก (แอป)</span>
      </button>

      {showIosGuide && (
        <div
          className="pwa-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-guide-title"
          onClick={() => setShowIosGuide(false)}
        >
          <div className="pwa-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="pwa-modal-head">
              <div className="pwa-modal-brand">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icons/icon-192.png" alt="kaikai" width={44} height={44} />
                <div>
                  <strong id="pwa-guide-title">ติดตั้งแอป kaikai</strong>
                  <span>เปิดเต็มจอเหมือนแอปจริง ไม่ติดแถบเว็บ</span>
                </div>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setShowIosGuide(false)}
                aria-label="ปิดหน้าต่าง"
              >
                <X size={18} />
              </button>
            </div>

            {isIos ? (
              <ol className="pwa-steps">
                <li>
                  <span>1</span>
                  <div>
                    <strong>แตะปุ่ม แชร์ (Share)</strong>
                    <small>
                      ไอคอนรูปสี่เหลี่ยมมีลูกศรชี้ขึ้น <Share size={13} style={{ verticalAlign: "middle" }} /> ที่แถบด้านล่างหรือมุมบนขวาของ Safari
                    </small>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>เลือก “เพิ่มไปยังหน้าจอโฮม” (Add to Home Screen)</strong>
                    <small>เลื่อนเมนูลงมาด้านล่างแล้วแตะคำสั่งเพิ่มไปยังหน้าจอโฮม</small>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <strong>แตะ “เพิ่ม” (Add) ที่มุมขวาบน</strong>
                    <small>ไอคอนแอป kaikai จะปรากฏบนหน้าจอหลักและเปิดแบบเต็มจอได้ทันที</small>
                  </div>
                </li>
              </ol>
            ) : (
              <ol className="pwa-steps">
                <li>
                  <span>1</span>
                  <div>
                    <strong>แตะเมนูเบราว์เซอร์ (⋮) ที่มุมขวาบน</strong>
                    <small>ใน Chrome หรือเบราว์เซอร์ที่ใช้งานอยู่</small>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>เลือก “ติดตั้งแอป” หรือ “เพิ่มลงในหน้าจอหลัก”</strong>
                    <small>กดยืนยันเพื่อสร้างไอคอนแอป kaikai บนหน้าจอมือถือ</small>
                  </div>
                </li>
              </ol>
            )}

            <button
              type="button"
              className="primary-button"
              style={{ width: "100%", marginTop: "14px" }}
              onClick={() => setShowIosGuide(false)}
            >
              เข้าใจแล้ว
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function PwaSettingsCard() {
  const { isStandalone, isIos, canInstallPrompt, triggerInstall } = usePwaState();
  const [showGuide, setShowGuide] = useState(false);

  return (
    <section className="panel settings-card">
      <h2>แอปพลิเคชันบนมือถือ (PWA)</h2>
      <div className="connection-row">
        <span>
          <i className={isStandalone ? "ok" : "warn"} />
          โหมดการแสดงผล
        </span>
        <strong>{isStandalone ? "กำลังใช้งานผ่านแอปหน้าจอหลัก" : "กำลังเปิดผ่านเบราว์เซอร์"}</strong>
      </div>

      {isStandalone ? (
        <p className="privacy-note">
          <CheckCircle2 size={17} />
          คุณติดตั้งและเปิดใช้งาน kaikai แบบเต็มจอ (Standalone App) เรียบร้อยแล้ว
        </p>
      ) : (
        <>
          <p className="field-hint">
            เพิ่ม <strong>kaikai</strong> ลงหน้าจอหลักของมือถือเพื่อเปิดใช้งานแบบเต็มจอเหมือนแอปจริง เข้าหน้าเปิดบิลและแนบสลิปได้ทันทีโดยไม่มีแถบ URL บังหน้าจอ
          </p>

          {canInstallPrompt ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => void triggerInstall()}
            >
              <Download size={17} />
              ติดตั้งแอป kaikai ลงเครื่อง
            </button>
          ) : (
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowGuide((prev) => !prev)}
            >
              <Smartphone size={17} />
              {showGuide ? "ซ่อนวิธีเพิ่มลงหน้าจอหลัก" : "ดูวิธีเพิ่มลงหน้าจอหลัก"}
            </button>
          )}

          {showGuide && (
            <div className="pwa-inline-guide">
              <strong>
                <Sparkles size={14} />{" "}
                {isIos ? "วิธีเพิ่มลงหน้าจอโฮมบน iPhone / iPad (Safari)" : "วิธีติดตั้งลงหน้าจอหลักบน Android / Chrome"}
              </strong>
              {isIos ? (
                <ol>
                  <li>แตะปุ่ม <strong>แชร์ (Share)</strong> ที่แถบด้านล่างของ Safari</li>
                  <li>เลื่อนลงมาเลือก <strong>“เพิ่มไปยังหน้าจอโฮม” (Add to Home Screen)</strong></li>
                  <li>แตะ <strong>“เพิ่ม” (Add)</strong> ที่มุมขวาบน แล้วเปิดแอปจากไอคอนบนหน้าจอโฮม</li>
                </ol>
              ) : (
                <ol>
                  <li>แตะปุ่มเมนู <strong>⋮</strong> ที่มุมขวาบนของ Chrome</li>
                  <li>เลือก <strong>“ติดตั้งแอป” (Install app)</strong> หรือ <strong>“เพิ่มลงในหน้าจอหลัก”</strong></li>
                  <li>กดยืนยัน แล้วเปิดแอป kaikai จากหน้าจอหลักได้ทันที</li>
                </ol>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
