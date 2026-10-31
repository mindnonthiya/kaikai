"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, CheckSquare, FileText, Loader2, Pencil, ShoppingBasket, Trash2, X } from "lucide-react";
import {
  deleteExpense,
  deleteExpensesBulkAction,
  replaceExpenseWithItemizedAction,
  updateExpenseAction,
} from "@/app/actions/expenses";
import { ActionButton } from "@/components/action-form";
import { ExpenseReceiptButton } from "@/components/expense-receipt-button";
import type { PerUnitPurchaseItem, PooledPurchaseItem } from "@/components/ingredient-purchase-table";
import type { RestockItem } from "@/components/packaging-restock-table";
import {
  SlipItemizedPicker,
  computeItemizedSummary,
  createInitialItemizedState,
  type ItemizedSelectionState,
} from "@/components/slip-itemized-picker";
import {
  EXPENSE_KIND_LABELS,
  FUEL_CATEGORY,
  PAYMENT_METHOD_LABELS,
  type ExpenseKind,
  type ExpenseRecord,
  type PaymentMethod,
} from "@/lib/data/types";
import { formatBaht, satangToBahtInput, tryBahtToSatang } from "@/lib/money";
import { bangkokDayKey, formatThaiShortDate } from "@/lib/time";

const QUICK_CATEGORIES = [FUEL_CATEGORY, "ค่าแก๊ส", "ค่าไฟ", "ค่าน้ำ", "วัตถุดิบ", "บรรจุภัณฑ์", "อุปกรณ์"];

export function ExpenseTable({
  expenses,
  searchQuery,
  categories = [],
  perUnit = [],
  pooled = [],
  restockItems = [],
  maxDate,
}: {
  expenses: ExpenseRecord[];
  searchQuery: string;
  categories?: string[];
  perUnit?: PerUnitPurchaseItem[];
  pooled?: PooledPurchaseItem[];
  restockItems?: RestockItem[];
  maxDate?: string;
}) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<"single" | "itemized">("single");
  const [editDescription, setEditDescription] = useState("");
  const [editAmountBaht, setEditAmountBaht] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editKind, setEditKind] = useState<ExpenseKind>("operating");
  const [editSpentAt, setEditSpentAt] = useState("");
  const [editPayee, setEditPayee] = useState("");
  const [editPaymentMethod, setEditPaymentMethod] = useState<PaymentMethod>("transfer");
  const [editItemizedState, setEditItemizedState] = useState<ItemizedSelectionState>(() =>
    createInitialItemizedState(perUnit, restockItems)
  );
  const [replaceAllWithSameSlip, setReplaceAllWithSameSlip] = useState(true);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const validSelectedIds = expenses.filter((e) => selectedIds.has(e.id)).map((e) => e.id);
  const selectedTotal = expenses
    .filter((e) => selectedIds.has(e.id))
    .reduce((sum, e) => sum + e.amount, 0);

  const allSelected = expenses.length > 0 && validSelectedIds.length === expenses.length;
  const noSlipIds = expenses.filter((e) => !e.receiptPath).map((e) => e.id);
  const oldPurchaseNoSlipIds = expenses
    .filter((e) => !e.receiptPath && (e.category === "วัตถุดิบ" || e.category === "บรรจุภัณฑ์"))
    .map((e) => e.id);

  function buildInitialItemizedFromExpenses(rowsToParse: ExpenseRecord[]): ItemizedSelectionState {
    const base = createInitialItemizedState(perUnit, restockItems);
    const sortedPerUnit = [...perUnit].sort((a, b) => b.name.length - a.name.length);
    const sortedPooled = [...pooled].sort((a, b) => b.name.length - a.name.length);
    const sortedPacks = [...restockItems].sort((a, b) => b.name.length - a.name.length);

    for (const r of rowsToParse) {
      const desc = r.description.trim();
      if (r.category === "วัตถุดิบ" && desc.startsWith("ซื้อ")) {
        const matchedPerUnit = sortedPerUnit.find(
          (i) => desc === `ซื้อ${i.name}` || desc.startsWith(`ซื้อ${i.name} `)
        );
        if (matchedPerUnit) {
          const rest = desc.slice(`ซื้อ${matchedPerUnit.name}`.length).trim();
          const numMatch = rest.match(/^([\d,.]+)/);
          const qty = numMatch ? Number(numMatch[1].replace(/,/g, "")) : 1;
          if (qty > 0) {
            base.perUnitQty[matchedPerUnit.id] = String(qty);
            base.perUnitPrice[matchedPerUnit.id] = satangToBahtInput(Math.round(r.amount / qty));
            continue;
          }
        }
        const matchedPooled = sortedPooled.find(
          (i) => desc === `ซื้อ${i.name}` || desc.startsWith(`ซื้อ${i.name} `)
        );
        if (matchedPooled) {
          const prevSatang = tryBahtToSatang(base.pooledAmount[matchedPooled.id] ?? "") ?? 0;
          base.pooledAmount[matchedPooled.id] = satangToBahtInput(prevSatang + r.amount);
          continue;
        }
      }

      if (r.category === "บรรจุภัณฑ์" && desc.startsWith("ซื้อ")) {
        const matchedPack = sortedPacks.find(
          (p) => desc === `ซื้อ${p.name}` || desc.startsWith(`ซื้อ${p.name} `)
        );
        if (matchedPack) {
          const rest = desc.slice(`ซื้อ${matchedPack.name}`.length).trim();
          const defaultPerPack = Number((matchedPack.perPack || "1").replace(/,/g, "")) || 1;
          const multiPackMatch = rest.match(/^([\d,]+)\s*แพ็ก\s*\(([\d,.]+)/);
          const singlePackMatch = rest.match(/^([\d,.]+)/);
          if (multiPackMatch) {
            const packs = Math.max(1, parseInt(multiPackMatch[1].replace(/,/g, ""), 10) || 1);
            const totalPieces = Number(multiPackMatch[2].replace(/,/g, "")) || 1;
            const rawPerPack = Math.round((totalPieces / packs) * 100) / 100;
            const effectivePerPack =
              rawPerPack;
            base.packaging[matchedPack.id] = {
              packs,
              priceBaht: satangToBahtInput(Math.round(r.amount / packs)),
              perPack: String(effectivePerPack),
            };
            continue;
          } else if (singlePackMatch) {
            const rawNum = Number(singlePackMatch[1].replace(/,/g, "")) || 1;
            const isPackWord = /แพ็ก/.test(rest);
            if (isPackWord) {
              const packs = Math.max(1, Math.round(rawNum));
              base.packaging[matchedPack.id] = {
                packs,
                priceBaht: satangToBahtInput(Math.round(r.amount / packs)),
                perPack: String(defaultPerPack),
              };
            } else {
              const effectivePieces =
                rawNum;
              base.packaging[matchedPack.id] = {
                packs: 1,
                priceBaht: satangToBahtInput(r.amount),
                perPack: String(effectivePieces),
              };
            }
            continue;
          } else {
            base.packaging[matchedPack.id] = {
              packs: 1,
              priceBaht: satangToBahtInput(r.amount),
              perPack: String(defaultPerPack),
            };
            continue;
          }
        }
      }

      base.extras.push({
        id: crypto.randomUUID(),
        description: r.description,
        category: r.category,
        kind: r.kind,
        amountBaht: satangToBahtInput(r.amount),
      });
    }

    return base;
  }

  function startEditing(e: ExpenseRecord) {
    if (editingId === e.id) {
      setEditingId(null);
      setEditError(null);
      return;
    }
    const sameSlip = e.receiptPath
      ? expenses.filter((x) => x.receiptPath === e.receiptPath)
      : [e];
    const isPurchaseOrMultiSlip =
      sameSlip.length > 1 || e.category === "วัตถุดิบ" || e.category === "บรรจุภัณฑ์";

    setEditingId(e.id);
    setEditMode(isPurchaseOrMultiSlip ? "itemized" : "single");
    setEditDescription(e.description);
    setEditAmountBaht(satangToBahtInput(e.amount));
    setEditCategory(e.category);
    setEditKind(e.kind);
    try {
      setEditSpentAt(bangkokDayKey(new Date(e.spentAt)));
    } catch {
      setEditSpentAt(bangkokDayKey(new Date()));
    }
    setEditPayee(e.payee ?? "");
    setEditPaymentMethod(e.paymentMethod ?? "transfer");
    setEditItemizedState(
      isPurchaseOrMultiSlip
        ? buildInitialItemizedFromExpenses(sameSlip)
        : createInitialItemizedState(perUnit, restockItems)
    );
    setReplaceAllWithSameSlip(true);
    setEditError(null);
  }

  async function handleSaveSingleEdit(expenseId: string) {
    setEditError(null);
    const amountSatang = tryBahtToSatang(editAmountBaht);
    if (!editDescription.trim()) {
      setEditError("กรุณากรอกรายละเอียด");
      return;
    }
    if (!editCategory.trim()) {
      setEditError("กรุณากรอกหมวดหมู่");
      return;
    }
    if (!amountSatang || amountSatang <= 0) {
      setEditError("กรุณากรอกจำนวนเงินที่ถูกต้อง");
      return;
    }

    setSavingEdit(true);
    try {
      const res = await updateExpenseAction({
        id: expenseId,
        spentAt: editSpentAt,
        description: editDescription.trim(),
        category: editCategory.trim(),
        kind: editKind,
        amountSatang,
        payee: editPayee.trim() || null,
        paymentMethod: editPaymentMethod,
      });
      if (!res.ok) {
        setEditError(res.error ?? "บันทึกการแก้ไขไม่สำเร็จ");
        return;
      }
      setEditingId(null);
      setFeedback({ ok: true, text: res.message ?? "บันทึกการแก้ไขเรียบร้อยแล้ว" });
      router.refresh();
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการบันทึก");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleSaveItemizedEdit(targetExpense: ExpenseRecord, sameSlipExpenses: ExpenseRecord[]) {
    setEditError(null);
    const computed = computeItemizedSummary(editItemizedState, perUnit, pooled, restockItems);
    if (computed.itemCount === 0) {
      setEditError("กรุณาเลือกวัตถุดิบ บรรจุภัณฑ์ หรือค่าใช้จ่ายอย่างน้อย 1 รายการ");
      return;
    }

    const idsToReplace =
      replaceAllWithSameSlip && sameSlipExpenses.length > 1
        ? sameSlipExpenses.map((x) => x.id)
        : [targetExpense.id];

    setSavingEdit(true);
    try {
      const res = await replaceExpenseWithItemizedAction(idsToReplace, {
        spentAt: editSpentAt,
        vendor: editPayee.trim() || null,
        paymentMethod: editPaymentMethod,
        receiptPath: targetExpense.receiptPath ?? null,
        perUnitItems: computed.perUnitItems,
        pooledItems: computed.pooledItems,
        packagingItems: computed.packagingItems,
        extraExpenses: computed.extraExpenses,
      });
      if (!res.ok) {
        setEditError(res.error ?? "อัปเดตรายการไม่สำเร็จ");
        return;
      }
      setEditingId(null);
      setFeedback({ ok: true, text: res.message ?? "อัปเดตรายการเรียบร้อยแล้ว" });
      router.refresh();
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : "เกิดข้อผิดพลาดในการอัปเดต");
    } finally {
      setSavingEdit(false);
    }
  }

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
            <th className="num">จัดการ</th>
          </tr>
        </thead>
        <tbody>
          {expenses.map((e) => {
            const isChecked = selectedIds.has(e.id);
            const isEditing = editingId === e.id;
            const sameSlipExpenses = e.receiptPath
              ? expenses.filter((x) => x.receiptPath === e.receiptPath)
              : [e];
            const sameSlipTotalSatang = sameSlipExpenses.reduce((sum, x) => sum + x.amount, 0);
            const singleEditAmountSatang = tryBahtToSatang(editAmountBaht) ?? e.amount;
            const targetSlipSatang =
              replaceAllWithSameSlip && sameSlipExpenses.length > 1
                ? sameSlipTotalSatang
                : singleEditAmountSatang;

            return (
              <Fragment key={e.id}>
                <tr
                  style={
                    isEditing
                      ? { background: "rgba(181, 82, 26, 0.08)" }
                      : isChecked
                      ? { background: "rgba(181, 56, 26, 0.05)" }
                      : undefined
                  }
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
                    <div
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "10px",
                        justifyContent: "flex-end",
                      }}
                    >
                      <button
                        type="button"
                        className="link-button"
                        style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                        onClick={() => startEditing(e)}
                      >
                        <Pencil size={13} />
                        <span>{isEditing ? "ปิด" : "แก้ไข"}</span>
                      </button>
                      <ActionButton
                        action={deleteExpense}
                        fields={{ id: e.id }}
                        label="ลบ"
                        confirmText={`ลบ “${e.description}” ${formatBaht(e.amount)}?`}
                        className="link-button danger"
                      />
                    </div>
                  </td>
                </tr>

                {isEditing && (
                  <tr>
                    <td
                      colSpan={8}
                      style={{
                        background: "#fffcf8",
                        padding: "16px 18px",
                        borderBottom: "2px solid var(--brand, #b5381a)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "10px",
                          marginBottom: "14px",
                        }}
                      >
                        <div>
                          <strong style={{ fontSize: "15px" }}>
                            แก้ไขรายการ: {e.description} ({formatBaht(e.amount)})
                          </strong>
                          {e.receiptPath && (
                            <span style={{ marginLeft: "10px" }}>
                              <ExpenseReceiptButton
                                receiptPath={e.receiptPath}
                                label="เปิดดูรูปสลิปของรายการนี้"
                              />
                            </span>
                          )}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <div className="slip-mode-switch" role="tablist">
                            <button
                              type="button"
                              role="tab"
                              aria-selected={editMode === "single"}
                              className={`slip-mode-pill ${editMode === "single" ? "active" : ""}`}
                              onClick={() => setEditMode("single")}
                            >
                              <FileText size={14} /> แก้ไขข้อมูลรายการนี้
                            </button>
                            <button
                              type="button"
                              role="tab"
                              aria-selected={editMode === "itemized"}
                              className={`slip-mode-pill ${editMode === "itemized" ? "active" : ""}`}
                              onClick={() => setEditMode("itemized")}
                            >
                              <ShoppingBasket size={14} /> แยกวัตถุดิบ / บรรจุภัณฑ์ใหม่
                            </button>
                          </div>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => setEditingId(null)}
                          >
                            <X size={15} /> ปิด
                          </button>
                        </div>
                      </div>

                      {editMode === "single" ? (
                        <div className="form-grid">
                          <label className="span-2">
                            รายละเอียด
                            <input
                              type="text"
                              value={editDescription}
                              maxLength={200}
                              onChange={(ev) => setEditDescription(ev.target.value)}
                              placeholder="เช่น เติมน้ำมันมอเตอร์ไซค์"
                            />
                          </label>
                          <label>
                            จำนวนเงิน (บาท)
                            <input
                              type="text"
                              inputMode="decimal"
                              value={editAmountBaht}
                              onChange={(ev) => setEditAmountBaht(ev.target.value)}
                              placeholder="เช่น 130"
                            />
                          </label>
                          <label>
                            หมวดหมู่
                            <input
                              type="text"
                              list="expense-categories"
                              value={editCategory}
                              maxLength={60}
                              onChange={(ev) => setEditCategory(ev.target.value)}
                              placeholder="เช่น ค่าน้ำมัน"
                            />
                            <span className="quick-chips">
                              {QUICK_CATEGORIES.map((c) => (
                                <button
                                  key={c}
                                  type="button"
                                  className="chip"
                                  onClick={() => setEditCategory(c)}
                                >
                                  {c}
                                </button>
                              ))}
                            </span>
                          </label>
                          <label>
                            ประเภท
                            <select
                              value={editKind}
                              onChange={(ev) => setEditKind(ev.target.value as ExpenseKind)}
                            >
                              <option value="operating">ดำเนินงาน (หักจากกำไร)</option>
                              <option value="direct">ต้นทุนโดยตรง (วัตถุดิบ/บรรจุภัณฑ์)</option>
                              <option value="one_time">ครั้งเดียว เช่น ซ่อมของ อุปกรณ์</option>
                              <option value="recurring">ประจำ เช่น ค่าเช่า เน็ต</option>
                            </select>
                          </label>
                          <label>
                            วันที่จ่าย
                            <input
                              type="date"
                              value={editSpentAt}
                              max={maxDate}
                              onChange={(ev) => setEditSpentAt(ev.target.value)}
                            />
                          </label>
                          <label>
                            วิธีชำระ
                            <select
                              value={editPaymentMethod}
                              onChange={(ev) =>
                                setEditPaymentMethod(ev.target.value as PaymentMethod)
                              }
                            >
                              <option value="transfer">เงินโอน</option>
                              <option value="cash">เงินสด</option>
                              <option value="other">อื่น ๆ</option>
                            </select>
                          </label>
                          <label className="span-2">
                            ผู้รับเงิน / ร้านค้า (ไม่บังคับ)
                            <input
                              type="text"
                              value={editPayee}
                              maxLength={120}
                              onChange={(ev) => setEditPayee(ev.target.value)}
                              placeholder="เช่น ปั๊ม ปตท. / ตลาดสด"
                            />
                          </label>

                          {editError && (
                            <p className="form-error wide" role="alert">
                              {editError}
                            </p>
                          )}

                          <div className="form-footer">
                            <button
                              type="button"
                              className="primary-button"
                              disabled={savingEdit}
                              onClick={() => handleSaveSingleEdit(e.id)}
                            >
                              {savingEdit ? (
                                <>
                                  <Loader2 size={15} className="spin-icon" /> กำลังบันทึก…
                                </>
                              ) : (
                                <>
                                  <Check size={15} /> บันทึกการแก้ไข
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={savingEdit}
                              onClick={() => setEditingId(null)}
                            >
                              ยกเลิก
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="form-grid" style={{ marginBottom: "12px" }}>
                            <label>
                              ร้านค้า / ผู้รับโอน
                              <input
                                type="text"
                                value={editPayee}
                                maxLength={120}
                                onChange={(ev) => setEditPayee(ev.target.value)}
                                placeholder="เช่น ตลาดสด / แม็คโคร"
                              />
                            </label>
                            <label>
                              วันที่จ่าย (ตามสลิป)
                              <input
                                type="date"
                                value={editSpentAt}
                                max={maxDate}
                                onChange={(ev) => setEditSpentAt(ev.target.value)}
                              />
                            </label>
                            <label>
                              วิธีชำระ
                              <select
                                value={editPaymentMethod}
                                onChange={(ev) =>
                                  setEditPaymentMethod(ev.target.value as PaymentMethod)
                                }
                              >
                                <option value="transfer">เงินโอน</option>
                                <option value="cash">เงินสด</option>
                                <option value="other">อื่น ๆ</option>
                              </select>
                            </label>
                            {sameSlipExpenses.length > 1 && (
                              <label className="check-label" style={{ alignSelf: "end" }}>
                                <input
                                  type="checkbox"
                                  checked={replaceAllWithSameSlip}
                                  onChange={(ev) => setReplaceAllWithSameSlip(ev.target.checked)}
                                />
                                แทนที่ทุกรายการที่มาจากสลิปใบเดียวกัน ({sameSlipExpenses.length} รายการ · รวม{" "}
                                {formatBaht(sameSlipTotalSatang)})
                              </label>
                            )}
                          </div>

                          <SlipItemizedPicker
                            perUnit={perUnit}
                            pooled={pooled}
                            restockItems={restockItems}
                            categories={categories}
                            slipAmountSatang={targetSlipSatang}
                            value={editItemizedState}
                            onChange={setEditItemizedState}
                          />

                          {editError && (
                            <p className="form-error" style={{ marginTop: 10 }} role="alert">
                              {editError}
                            </p>
                          )}

                          <div
                            className="form-footer"
                            style={{ marginTop: "14px", display: "flex", gap: "10px" }}
                          >
                            <button
                              type="button"
                              className="primary-button"
                              disabled={savingEdit}
                              onClick={() => handleSaveItemizedEdit(e, sameSlipExpenses)}
                            >
                              {savingEdit ? (
                                <>
                                  <Loader2 size={15} className="spin-icon" /> กำลังอัปเดต…
                                </>
                              ) : (
                                <>
                                  <Check size={15} /> บันทึกรายการย่อยใหม่แทนที่ของเดิม
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={savingEdit}
                              onClick={() => setEditingId(null)}
                            >
                              ยกเลิก
                            </button>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
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
