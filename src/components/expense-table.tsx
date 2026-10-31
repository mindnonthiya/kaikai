"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CheckSquare, Loader2, Trash2, X } from "lucide-react";
import { deleteExpense, deleteExpensesBulkAction } from "@/app/actions/expenses";
import { ActionButton } from "@/components/action-form";
import { ExpenseReceiptButton } from "@/components/expense-receipt-button";
import { EXPENSE_KIND_LABELS, PAYMENT_METHOD_LABELS, type ExpenseRecord } from "@/lib/data/types";
import { formatBaht } from "@/lib/money";
import { formatThaiShortDate } from "@/lib/time";

export function ExpenseTable({
  expenses,
  searchQuery,
}: {
  expenses: ExpenseRecord[];
  searchQuery: string;
}) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const validSelectedIds = expenses.filter((e) => selectedIds.has(e.id)).map((e) => e.id);
  const selectedTotal = expenses
    .filter((e) => selectedIds.has(e.id))
    .reduce((sum, e) => sum + e.amount, 0);

  const allSelected = expenses.length > 0 && validSelectedIds.length === expenses.length;
  const noSlipIds = expenses.filter((e) => !e.receiptPath).map((e) => e.id);
  const oldPurchaseNoSlipIds = expenses
    .filter((e) => !e.receiptPath && (e.category === "วัตถุดิบ" || e.category === "บรรจุภัณฑ์"))
    .map((e) => e.id);

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(expenses.map((e) => e.id)));
    }
  }

  function selectIds(ids: string[]) {
    setSelectedIds(new Set(ids));
  }

  function handleBulkDelete() {
    if (validSelectedIds.length === 0 || isPending) return;
    const confirmed = window.confirm(
      `ยืนยันลบรายการที่เลือกทั้งหมด ${validSelectedIds.length} รายการ (รวม ${formatBaht(selectedTotal)}) พร้อมกันหรือไม่?\nระบบจะลบประวัติการซื้อวัตถุดิบ/บรรจุภัณฑ์ที่ผูกอยู่และคำนวณต้นทุนใหม่ให้อัตโนมัติ`
    );
    if (!confirmed) return;

    setFeedback(null);
    startTransition(async () => {
      const res = await deleteExpensesBulkAction(validSelectedIds);
      if (res.ok) {
        setSelectedIds(new Set());
        setFeedback({ ok: true, text: res.message ?? `ลบ ${validSelectedIds.length} รายการแล้ว` });
        router.refresh();
      } else {
        setFeedback({ ok: false, text: res.error ?? "ลบรายการไม่สำเร็จ" });
      }
    });
  }

  return (
    <>
      {expenses.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            padding: "10px 14px",
            borderBottom: "1px solid var(--line, #eadfce)",
            background: validSelectedIds.length > 0 ? "rgba(181, 56, 26, 0.06)" : "rgba(255, 250, 243, 0.6)",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "13px", fontWeight: 600 }}>
              {validSelectedIds.length > 0
                ? `เลือกแล้ว ${validSelectedIds.length} รายการ (${formatBaht(selectedTotal)})`
                : "เลือกหลายรายการเพื่อลบพร้อมกัน:"}
            </span>
            {oldPurchaseNoSlipIds.length > 0 && (
              <button
                type="button"
                className="chip"
                onClick={() => selectIds(oldPurchaseNoSlipIds)}
                disabled={isPending}
              >
                <CheckSquare size={13} style={{ marginRight: 4 }} />
                เลือกซื้อวัตถุดิบ/บรรจุภัณฑ์ที่ไม่มีสลิป ({oldPurchaseNoSlipIds.length})
              </button>
            )}
            {noSlipIds.length > 0 && noSlipIds.length !== oldPurchaseNoSlipIds.length && (
              <button
                type="button"
                className="chip"
                onClick={() => selectIds(noSlipIds)}
                disabled={isPending}
              >
                เลือกทุกรายการที่ไม่มีสลิป ({noSlipIds.length})
              </button>
            )}
          </div>

          {validSelectedIds.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                type="button"
                className="link-button"
                onClick={() => setSelectedIds(new Set())}
                disabled={isPending}
              >
                <X size={14} /> ยกเลิกการเลือก
              </button>
              <button
                type="button"
                className="primary-button"
                style={{ background: "#b91c1c", borderColor: "#b91c1c" }}
                onClick={handleBulkDelete}
                disabled={isPending}
              >
                {isPending ? (
                  <>
                    <Loader2 size={15} className="spin-icon" /> กำลังลบ {validSelectedIds.length} รายการ…
                  </>
                ) : (
                  <>
                    <Trash2 size={15} /> ลบที่เลือก ({validSelectedIds.length} รายการ)
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {feedback && (
        <div
          style={{
            padding: "8px 14px",
            fontSize: "13px",
            color: feedback.ok ? "#15803d" : "#b91c1c",
            background: feedback.ok ? "#f0fdf4" : "#fef2f2",
            borderBottom: "1px solid var(--line, #eadfce)",
          }}
        >
          {feedback.text}
        </div>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 36, textAlign: "center" }}>
              {expenses.length > 0 && (
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="เลือกทั้งหมด"
                />
              )}
            </th>
            <th>วันที่</th>
            <th>รายละเอียด</th>
            <th>ประเภท</th>
            <th>ผู้รับเงิน</th>
            <th>วิธีชำระ / สลิป</th>
            <th className="num">จำนวน</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {expenses.map((e) => {
            const isChecked = selectedIds.has(e.id);
            return (
              <tr
                key={e.id}
                style={isChecked ? { background: "rgba(181, 56, 26, 0.05)" } : undefined}
              >
                <td style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleOne(e.id)}
                    aria-label={`เลือก ${e.description}`}
                  />
                </td>
                <td>{formatThaiShortDate(e.spentAt)}</td>
                <td>
                  <strong>{e.description}</strong>
                  <br />
                  <small className="muted">{e.category}</small>
                </td>
                <td>
                  <span className={`status ${e.kind === "direct" ? "muted" : "pending"}`}>
                    {EXPENSE_KIND_LABELS[e.kind]}
                  </span>
                </td>
                <td>{e.payee ?? "—"}</td>
                <td>
                  {e.paymentMethod ? PAYMENT_METHOD_LABELS[e.paymentMethod] : "—"}
                  {e.receiptPath && (
                    <>
                      <br />
                      <ExpenseReceiptButton receiptPath={e.receiptPath} />
                    </>
                  )}
                </td>
                <td className="num">
                  <strong>{formatBaht(e.amount)}</strong>
                </td>
                <td className="num">
                  <ActionButton
                    action={deleteExpense}
                    fields={{ id: e.id }}
                    label="ลบ"
                    confirmText={`ลบ “${e.description}” ${formatBaht(e.amount)}?`}
                    className="link-button danger"
                  />
                </td>
              </tr>
            );
          })}
          {!expenses.length && (
            <tr>
              <td colSpan={8}>
                <div className="empty-state">
                  {searchQuery ? `ไม่พบรายการที่ตรงกับ “${searchQuery}”` : "ยังไม่มีค่าใช้จ่ายในช่วงนี้"}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
