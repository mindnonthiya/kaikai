"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus, RefreshCw, Search } from "lucide-react";
import {
  queryLoyaltyMembersPageAction,
} from "@/app/actions/loyalty";
import {
  LOYALTY_ADMIN_PAGE_SIZE,
  type LoyaltyConfig,
  type LoyaltyMemberSummary,
  formatValidTillDate,
} from "@/lib/loyalty";
import { LineProfileAvatar, type MemberFilter } from "./rewards-shared";

export function RewardsMembersTab({
  shopId,
  config,
  initialMembers,
  initialTotal,
  initiallyLoaded,
  isPending,
  refreshVersion,
  onSelectMember,
  onQuickAdjustMember,
}: {
  shopId: string;
  config: LoyaltyConfig;
  initialMembers: LoyaltyMemberSummary[];
  initialTotal: number;
  initiallyLoaded: boolean;
  isPending: boolean;
  refreshVersion: number;
  onSelectMember: (member: LoyaltyMemberSummary) => void;
  onQuickAdjustMember: (memberId: string, delta: number) => void;
}) {
  const [members, setMembers] = useState<LoyaltyMemberSummary[]>(initialMembers);
  const [totalCount, setTotalCount] = useState<number>(initialTotal);
  const [memberSearch, setMemberSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("all");
  const [memberPage, setMemberPage] = useState(1);
  const [isLoadingPage, setIsLoadingPage] = useState(!initiallyLoaded);
  const hasFetchedRef = useRef(initiallyLoaded);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(memberSearch.trim());
    }, 260);
    return () => clearTimeout(t);
  }, [memberSearch]);

  const loadMembersPage = useCallback(
    async (pageToLoad: number, search: string, filter: MemberFilter) => {
      setIsLoadingPage(true);
      try {
        const res = await queryLoyaltyMembersPageAction({
          shopId,
          query: search,
          filter,
          page: pageToLoad,
          pageSize: LOYALTY_ADMIN_PAGE_SIZE,
          stampsPerReward: config.stampsPerReward,
        });
        if (res.ok) {
          setMembers(res.items);
          setTotalCount(res.total);
        }
      } finally {
        setIsLoadingPage(false);
      }
    },
    [shopId, config.stampsPerReward],
  );

  useEffect(() => {
    if (
      !hasFetchedRef.current ||
      debouncedSearch !== "" ||
      memberFilter !== "all" ||
      memberPage !== 1 ||
      refreshVersion > 0
    ) {
      hasFetchedRef.current = true;
      void loadMembersPage(memberPage, debouncedSearch, memberFilter);
    }
  }, [debouncedSearch, memberFilter, memberPage, refreshVersion, loadMembersPage]);

  const totalMemberPages = Math.max(1, Math.ceil(totalCount / LOYALTY_ADMIN_PAGE_SIZE));
  const safeMemberPage = Math.min(memberPage, totalMemberPages);

  return (
    <div className="loyalty-tab-content">
      <section className="panel loyalty-section-card">
        <div className="loyalty-section-head">
          <div>
            <h3>รายชื่อสมาชิกสะสมแต้ม ({totalCount.toLocaleString()} คน)</h3>
            <p className="field-hint">
              แสดงรูปโปรไฟล์และชื่อจากบัญชี LINE ของลูกค้าโดยตรง กดที่รายชื่อเพื่อดูประวัติและปรับแต้ม
            </p>
          </div>
          <button
            type="button"
            className="button ghost"
            disabled={isLoadingPage}
            onClick={() => void loadMembersPage(safeMemberPage, debouncedSearch, memberFilter)}
          >
            <RefreshCw size={15} />
            รีเฟรช
          </button>
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
              ทั้งหมด
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
          </div>
        </div>

        {isLoadingPage && members.length === 0 ? (
          <div className="loyalty-empty-box">กำลังโหลดรายชื่อสมาชิกจากฐานข้อมูล...</div>
        ) : members.length === 0 ? (
          <div className="loyalty-empty-box">
            {debouncedSearch || memberFilter !== "all"
              ? "ไม่พบรายชื่อลูกค้าที่ตรงกับเงื่อนไขการค้นหา"
              : "ยังไม่มีสมาชิกสะสมแต้มในร้านนี้ เมื่อลูกค้าเปิดบัตรหรือสแกน QR ข้อมูลโปรไฟล์ LINE จะแสดงที่นี่อัตโนมัติ"}
          </div>
        ) : (
          <div className="loyalty-clean-list">
            {members.map((m) => {
              const isLineAccount = m.lineUserId.startsWith("U");
              return (
                <div key={m.id} className="loyalty-clean-row">
                  <div
                    className="loyalty-member-cell clickable"
                    onClick={() => onSelectMember(m)}
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
                        · สะสมรวม {m.lifetimeStamps.toLocaleString()} แต้ม · หมดอายุ{" "}
                        {formatValidTillDate(m.expiresAt)}
                      </span>
                    </div>
                  </div>

                  <div className="loyalty-member-actions">
                    <button
                      type="button"
                      className="button ghost"
                      disabled={isPending || m.stamps <= 0}
                      onClick={() => onQuickAdjustMember(m.id, -1)}
                      title="ลด 1 แต้ม"
                    >
                      <Minus size={14} /> 1
                    </button>
                    <button
                      type="button"
                      className="button ghost"
                      disabled={isPending}
                      onClick={() => onQuickAdjustMember(m.id, 1)}
                      title="เพิ่ม 1 แต้ม"
                    >
                      <Plus size={14} /> 1
                    </button>
                    <button
                      type="button"
                      className="button ghost"
                      onClick={() => onSelectMember(m)}
                    >
                      รายละเอียด
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Database Pagination Controls */}
        {totalMemberPages > 1 && (
          <div className="loyalty-pagination">
            <button
              type="button"
              className="button ghost"
              disabled={safeMemberPage <= 1 || isLoadingPage}
              onClick={() => setMemberPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft size={16} /> ก่อนหน้า
            </button>
            <span>
              หน้า {safeMemberPage.toLocaleString()} จาก {totalMemberPages.toLocaleString()} (รวม{" "}
              {totalCount.toLocaleString()} คน)
            </span>
            <button
              type="button"
              className="button ghost"
              disabled={safeMemberPage >= totalMemberPages || isLoadingPage}
              onClick={() => setMemberPage((p) => Math.min(totalMemberPages, p + 1))}
            >
              ถัดไป <ChevronRight size={16} />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
