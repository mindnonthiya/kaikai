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
  const prevRefreshVersionRef = useRef(refreshVersion);

  useEffect(() => {
    if (debouncedSearch === "" && memberFilter === "all" && memberPage === 1) {
      setMembers(initialMembers);
      setTotalCount(initialTotal);
    }
  }, [initialMembers, initialTotal, debouncedSearch, memberFilter, memberPage]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(memberSearch.trim());
    }, 220);
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
    const refreshChanged = refreshVersion !== prevRefreshVersionRef.current;
    prevRefreshVersionRef.current = refreshVersion;

    if (
      !hasFetchedRef.current ||
      debouncedSearch !== "" ||
      memberFilter !== "all" ||
      memberPage !== 1 ||
      refreshChanged
    ) {
      hasFetchedRef.current = true;
      void loadMembersPage(memberPage, debouncedSearch, memberFilter);
    }
  }, [debouncedSearch, memberFilter, memberPage, refreshVersion, loadMembersPage]);

  const handleOptimisticAdjust = (member: LoyaltyMemberSummary, delta: number) => {
    setMembers((prev) =>
      prev.map((item) => {
        if (item.id !== member.id) return item;
        const rawNext = Math.max(0, item.stamps + delta);
        const unlocked = delta > 0 ? Math.floor(rawNext / config.stampsPerReward) : 0;
        const nextStamps = delta > 0 ? rawNext % config.stampsPerReward : rawNext;
        return {
          ...item,
          stamps: nextStamps,
          lifetimeStamps: delta > 0 ? item.lifetimeStamps + delta : item.lifetimeStamps,
          unclaimedCount: item.unclaimedCount + unlocked,
        };
      }),
    );
    onQuickAdjustMember(member.id, delta);
  };

  const totalMemberPages = Math.max(1, Math.ceil(totalCount / LOYALTY_ADMIN_PAGE_SIZE));
  const safeMemberPage = Math.min(memberPage, totalMemberPages);

  return (
    <div className="loyalty-tab-content">
      <section className="panel loyalty-section-card">
        <div className="loyalty-section-head">
          <h3>ลูกค้า ({totalCount.toLocaleString()} คน)</h3>
          <button
            type="button"
            className="button ghost"
            disabled={isLoadingPage}
            onClick={() => void loadMembersPage(safeMemberPage, debouncedSearch, memberFilter)}
          >
            <RefreshCw size={14} />
            รีเฟรช
          </button>
        </div>

        {/* Search & Filter Toolbar */}
        <div className="loyalty-toolbar">
          <div className="loyalty-search-box">
            <Search size={16} className="loyalty-search-icon" />
            <input
              type="search"
              placeholder="ค้นหาชื่อลูกค้า..."
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
              มีคูปอง
            </button>
            <button
              type="button"
              className={`loyalty-filter-pill ${memberFilter === "near_reward" ? "active" : ""}`}
              onClick={() => {
                setMemberFilter("near_reward");
                setMemberPage(1);
              }}
            >
              ใกล้ครบ
            </button>
          </div>
        </div>

        {isLoadingPage && members.length === 0 ? (
          <div className="loyalty-empty-box">กำลังโหลดรายชื่อลูกค้า...</div>
        ) : members.length === 0 ? (
          <div className="loyalty-empty-box">
            {debouncedSearch || memberFilter !== "all"
              ? "ไม่พบรายชื่อลูกค้าที่ค้นหา"
              : "ยังไม่มีลูกค้าสะสมแต้มในร้านนี้"}
          </div>
        ) : (
          <div className="loyalty-clean-list">
            {members.map((m) => (
              <div key={m.id} className="loyalty-clean-row loyalty-member-row">
                <div
                  className="loyalty-member-cell clickable"
                  onClick={() => onSelectMember(m)}
                >
                  <LineProfileAvatar
                    pictureUrl={m.pictureUrl}
                    displayName={m.displayName}
                    lineUserId={m.lineUserId}
                    size={42}
                  />
                  <div className="loyalty-member-info">
                    <div className="loyalty-member-name-row">
                      <strong>{m.displayName}</strong>
                      {m.unclaimedCount > 0 && (
                        <span className="loyalty-ready-coupon-tag">
                          คูปอง {m.unclaimedCount}
                        </span>
                      )}
                    </div>
                    <span className="loyalty-member-meta">
                      <strong>
                        {m.stamps}/{config.stampsPerReward}
                      </strong>{" "}
                      แต้ม · สะสม {m.lifetimeStamps.toLocaleString()}
                      {m.expiresAt ? ` · หมดอายุ ${formatValidTillDate(m.expiresAt)}` : ""}
                    </span>
                  </div>
                </div>

                <div className="loyalty-member-actions">
                  <button
                    type="button"
                    className="button ghost loyalty-compact-btn"
                    disabled={isPending || m.stamps <= 0}
                    onClick={() => handleOptimisticAdjust(m, -1)}
                    title="ลด 1 แต้ม"
                  >
                    <Minus size={13} />1
                  </button>
                  <button
                    type="button"
                    className="button ghost loyalty-compact-btn"
                    disabled={isPending}
                    onClick={() => handleOptimisticAdjust(m, 1)}
                    title="เพิ่ม 1 แต้ม"
                  >
                    <Plus size={13} />1
                  </button>
                  <button
                    type="button"
                    className="button ghost loyalty-compact-btn"
                    onClick={() => onSelectMember(m)}
                  >
                    ดู
                  </button>
                </div>
              </div>
            ))}
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
