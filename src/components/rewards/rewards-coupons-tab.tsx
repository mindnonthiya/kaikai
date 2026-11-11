"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, RefreshCw, Ticket } from "lucide-react";
import {
  type LoyaltyActivityLogItem,
  type LoyaltyAdminCouponItem,
  type LoyaltyOverviewMetrics,
  queryLoyaltyCouponsPageAction,
  queryLoyaltyLogsPageAction,
} from "@/app/actions/loyalty";
import { LOYALTY_ADMIN_PAGE_SIZE, type LoyaltyConfig, formatThaiDateTime } from "@/lib/loyalty";
import {
  type CouponSubTab,
  LineProfileAvatar,
  formatActionLabel,
} from "./rewards-shared";

export function RewardsCouponsTab({
  shopId,
  config,
  metrics,
  initialCoupons,
  initialLogs,
  initialLogsTotal,
  initiallyLoadedCoupons,
  subTab,
  onSelectSubTab,
  isPending,
  refreshVersion,
  onRedeemCouponCode,
}: {
  shopId: string;
  config: LoyaltyConfig;
  metrics: LoyaltyOverviewMetrics;
  initialCoupons: LoyaltyAdminCouponItem[];
  initialLogs: LoyaltyActivityLogItem[];
  initialLogsTotal: number;
  initiallyLoadedCoupons: boolean;
  subTab: CouponSubTab;
  onSelectSubTab: (sub: CouponSubTab) => void;
  isPending: boolean;
  refreshVersion: number;
  onRedeemCouponCode: (code: string) => void;
}) {
  const [couponCodeInput, setCouponCodeInput] = useState("");
  const [debouncedLookup, setDebouncedLookup] = useState("");
  const [lookupMatches, setLookupMatches] = useState<LoyaltyAdminCouponItem[]>([]);
  const [isLookingUp, setIsLookingUp] = useState(false);

  const [coupons, setCoupons] = useState<LoyaltyAdminCouponItem[]>(initialCoupons);
  const [couponsTotal, setCouponsTotal] = useState<number>(metrics.readyCouponsCount);
  const [couponPage, setCouponPage] = useState(1);
  const [isLoadingCoupons, setIsLoadingCoupons] = useState(!initiallyLoadedCoupons && subTab !== "logs");

  const [logs, setLogs] = useState<LoyaltyActivityLogItem[]>(initialLogs);
  const [logsTotal, setLogsTotal] = useState<number>(initialLogsTotal);
  const [logPage, setLogPage] = useState(1);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);

  const skipInitialUnclaimedFetchRef = useRef(initiallyLoadedCoupons);
  const skipInitialLogsFetchRef = useRef(initiallyLoadedCoupons);
  const prevRefreshVersionRef = useRef(refreshVersion);

  useEffect(() => {
    if (subTab === "unclaimed" && couponPage === 1) {
      setCoupons(initialCoupons);
      setCouponsTotal(metrics.readyCouponsCount);
    }
  }, [initialCoupons, metrics.readyCouponsCount, subTab, couponPage]);

  useEffect(() => {
    if (logPage === 1) {
      setLogs(initialLogs);
      setLogsTotal(initialLogsTotal);
    }
  }, [initialLogs, initialLogsTotal, logPage]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedLookup(couponCodeInput.replace(/^#/, "").trim());
    }, 240);
    return () => clearTimeout(t);
  }, [couponCodeInput]);

  // Live database lookup when typing in the coupon verification box
  useEffect(() => {
    if (debouncedLookup.length < 2) {
      setLookupMatches([]);
      return;
    }
    let cancelled = false;
    setIsLookingUp(true);
    void queryLoyaltyCouponsPageAction({
      shopId,
      query: debouncedLookup,
      status: "all",
      page: 1,
      pageSize: 6,
      rewardTitleFallback: config.rewardTitle,
    }).then((res) => {
      if (cancelled) return;
      setIsLookingUp(false);
      if (res.ok) {
        setLookupMatches(res.items);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [debouncedLookup, shopId, config.rewardTitle, refreshVersion]);

  const loadCouponsPage = useCallback(
    async (statusToLoad: "unclaimed" | "claimed", pageToLoad: number) => {
      setIsLoadingCoupons(true);
      try {
        const res = await queryLoyaltyCouponsPageAction({
          shopId,
          status: statusToLoad,
          page: pageToLoad,
          pageSize: LOYALTY_ADMIN_PAGE_SIZE,
          rewardTitleFallback: config.rewardTitle,
        });
        if (res.ok) {
          setCoupons(res.items);
          setCouponsTotal(res.total);
        }
      } finally {
        setIsLoadingCoupons(false);
      }
    },
    [shopId, config.rewardTitle],
  );

  const loadLogsPage = useCallback(
    async (pageToLoad: number) => {
      setIsLoadingLogs(true);
      try {
        const res = await queryLoyaltyLogsPageAction({
          shopId,
          page: pageToLoad,
          pageSize: LOYALTY_ADMIN_PAGE_SIZE,
        });
        if (res.ok) {
          setLogs(res.items);
          setLogsTotal(res.total);
        }
      } finally {
        setIsLoadingLogs(false);
      }
    },
    [shopId],
  );

  useEffect(() => {
    const refreshChanged = refreshVersion !== prevRefreshVersionRef.current;
    prevRefreshVersionRef.current = refreshVersion;

    if (subTab === "unclaimed" || subTab === "claimed") {
      if (
        skipInitialUnclaimedFetchRef.current &&
        subTab === "unclaimed" &&
        couponPage === 1 &&
        !refreshChanged
      ) {
        skipInitialUnclaimedFetchRef.current = false;
        return;
      }
      skipInitialUnclaimedFetchRef.current = false;
      void loadCouponsPage(subTab, couponPage);
    } else if (subTab === "logs") {
      if (
        skipInitialLogsFetchRef.current &&
        logPage === 1 &&
        !refreshChanged
      ) {
        skipInitialLogsFetchRef.current = false;
        return;
      }
      skipInitialLogsFetchRef.current = false;
      void loadLogsPage(logPage);
    }
  }, [subTab, couponPage, logPage, refreshVersion, loadCouponsPage, loadLogsPage]);

  const totalCouponPages = Math.max(1, Math.ceil(couponsTotal / LOYALTY_ADMIN_PAGE_SIZE));
  const safeCouponPage = Math.min(couponPage, totalCouponPages);

  const totalLogPages = Math.max(1, Math.ceil(logsTotal / LOYALTY_ADMIN_PAGE_SIZE));
  const safeLogPage = Math.min(logPage, totalLogPages);

  return (
    <div className="loyalty-tab-content">
      {/* Instant Verify / Redeem Box */}
      <section className="panel loyalty-section-card loyalty-coupon-verify-panel">
        <div className="loyalty-section-head">
          <h3>ตรวจและตัดสิทธิ์คูปอง</h3>
        </div>

        <form
          className="loyalty-coupon-verify-bar"
          onSubmit={(e) => {
            e.preventDefault();
            const clean = couponCodeInput.replace(/^#/, "").trim();
            if (!clean) return;
            onRedeemCouponCode(clean);
            setCouponCodeInput("");
          }}
        >
          <div className="loyalty-search-box" style={{ flex: 1 }}>
            <Ticket size={17} className="loyalty-search-icon" />
            <input
              type="text"
              placeholder="กรอกรหัสคูปอง เช่น GT-8F4K2A หรือชื่อลูกค้า..."
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
            ตัดสิทธิ์คูปอง
          </button>
        </form>

        {/* Live matching results from database while typing */}
        {debouncedLookup.length >= 2 && (
          <div className="loyalty-live-coupon-matches">
            <span className="loyalty-sub-label">
              {isLookingUp
                ? "กำลังค้นหาคูปองจากฐานข้อมูล..."
                : `ผลการค้นหาที่ตรงกัน (${lookupMatches.length} รายการ)`}
            </span>
            {!isLookingUp && lookupMatches.length === 0 ? (
              <div className="loyalty-empty-box" style={{ padding: 12 }}>
                ไม่พบคูปองที่ตรงกับ “{couponCodeInput}”
              </div>
            ) : (
              <div className="loyalty-clean-list">
                {lookupMatches.map((c) => (
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
                          onClick={() => {
                            onRedeemCouponCode(c.code);
                            setCouponCodeInput("");
                          }}
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
        <div className="loyalty-toolbar">
          <div className="loyalty-sub-tabs">
            <button
              type="button"
              className={`loyalty-filter-pill ${subTab === "unclaimed" ? "active" : ""}`}
              onClick={() => {
                onSelectSubTab("unclaimed");
                setCouponPage(1);
              }}
            >
              พร้อมใช้ ({metrics.readyCouponsCount.toLocaleString()})
            </button>
            <button
              type="button"
              className={`loyalty-filter-pill ${subTab === "claimed" ? "active" : ""}`}
              onClick={() => {
                onSelectSubTab("claimed");
                setCouponPage(1);
              }}
            >
              ใช้แล้ว ({metrics.usedCouponsCount.toLocaleString()})
            </button>
            <button
              type="button"
              className={`loyalty-filter-pill ${subTab === "logs" ? "active" : ""}`}
              onClick={() => {
                onSelectSubTab("logs");
                setLogPage(1);
              }}
            >
              ประวัติแต้ม ({logsTotal.toLocaleString()})
            </button>
          </div>

          <button
            type="button"
            className="button ghost"
            disabled={isLoadingCoupons || isLoadingLogs}
            onClick={() => {
              if (subTab === "logs") {
                void loadLogsPage(safeLogPage);
              } else {
                void loadCouponsPage(subTab, safeCouponPage);
              }
            }}
          >
            <RefreshCw size={15} />
            รีเฟรช
          </button>
        </div>

        {(subTab === "unclaimed" || subTab === "claimed") && (
          <>
            {isLoadingCoupons && coupons.length === 0 ? (
              <div className="loyalty-empty-box">กำลังโหลดรายการคูปองจากฐานข้อมูล...</div>
            ) : coupons.length === 0 ? (
              <div className="loyalty-empty-box">
                {subTab === "unclaimed"
                  ? "ยังไม่มีคูปองที่รอใช้สิทธิ์ในขณะนี้"
                  : "ยังไม่มีประวัติคูปองที่ถูกใช้สิทธิ์"}
              </div>
            ) : (
              <div className="loyalty-clean-list">
                {coupons.map((c) => (
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
                          <span
                            className={`loyalty-code-pill ${c.status === "claimed" ? "muted" : ""}`}
                          >
                            #{c.code}
                          </span>
                        </div>
                        <span className="loyalty-member-meta">
                          {c.title} ·{" "}
                          {c.status === "claimed"
                            ? `ใช้สิทธิ์เมื่อ ${formatThaiDateTime(c.claimedAt)}`
                            : `ออกคูปองเมื่อ ${formatThaiDateTime(c.issuedAt)}`}
                        </span>
                      </div>
                    </div>
                    <div className="loyalty-member-actions">
                      {c.status === "unclaimed" ? (
                        <>
                          <span className="loyalty-coupon-status unclaimed">ยังไม่ใช้สิทธิ์</span>
                          <button
                            type="button"
                            className="button primary"
                            disabled={isPending}
                            onClick={() => onRedeemCouponCode(c.code)}
                          >
                            ตัดสิทธิ์ให้ลูกค้า
                          </button>
                        </>
                      ) : (
                        <span className="loyalty-coupon-status claimed">ใช้สิทธิ์แล้ว</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {totalCouponPages > 1 && (
              <div className="loyalty-pagination">
                <button
                  type="button"
                  className="button ghost"
                  disabled={safeCouponPage <= 1 || isLoadingCoupons}
                  onClick={() => setCouponPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft size={16} /> ก่อนหน้า
                </button>
                <span>
                  หน้า {safeCouponPage.toLocaleString()} จาก {totalCouponPages.toLocaleString()} (รวม{" "}
                  {couponsTotal.toLocaleString()} ใบ)
                </span>
                <button
                  type="button"
                  className="button ghost"
                  disabled={safeCouponPage >= totalCouponPages || isLoadingCoupons}
                  onClick={() => setCouponPage((p) => Math.min(totalCouponPages, p + 1))}
                >
                  ถัดไป <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}

        {subTab === "logs" && (
          <>
            {isLoadingLogs && logs.length === 0 ? (
              <div className="loyalty-empty-box">กำลังโหลดประวัติจากฐานข้อมูล...</div>
            ) : logs.length === 0 ? (
              <div className="loyalty-empty-box">ยังไม่มีประวัติการสะสมแต้ม</div>
            ) : (
              <div className="loyalty-clean-list">
                {logs.map((log) => (
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

            {totalLogPages > 1 && (
              <div className="loyalty-pagination">
                <button
                  type="button"
                  className="button ghost"
                  disabled={safeLogPage <= 1 || isLoadingLogs}
                  onClick={() => setLogPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft size={16} /> ก่อนหน้า
                </button>
                <span>
                  หน้า {safeLogPage.toLocaleString()} จาก {totalLogPages.toLocaleString()} (รวม{" "}
                  {logsTotal.toLocaleString()} รายการ)
                </span>
                <button
                  type="button"
                  className="button ghost"
                  disabled={safeLogPage >= totalLogPages || isLoadingLogs}
                  onClick={() => setLogPage((p) => Math.min(totalLogPages, p + 1))}
                >
                  ถัดไป <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
