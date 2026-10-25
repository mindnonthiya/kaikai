import Link from "next/link";
import { ArrowRight, CheckCircle2, Coins, Wallet } from "lucide-react";
import { PageTitle } from "@/components/page-title";
import { StatCard } from "@/components/stat-card";
import { ActionButton, ActionForm } from "@/components/action-form";
import { CashCounter } from "@/components/cash-counter";
import { closeCashShift, deleteCashShift, openCashShift } from "@/app/actions/cash-shifts";
import { filterExpenses, filterSales, summarize } from "@/lib/analytics";
import { fetchCashShifts, fetchCurrentCashShift, fetchExpenses, fetchSales } from "@/lib/data/queries";
import { formatBaht } from "@/lib/money";
import { DAY_MS, bangkokDayKey, formatThaiShortDate, formatTime, fromBangkokDateInput, startOfBangkokDay } from "@/lib/time";

export default async function CashDrawerPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  const now = new Date();
  const todayKey = bangkokDayKey(now);
  const selectedDateKey = params.date || todayKey;

  let selectedDayStart: Date;
  try {
    selectedDayStart = fromBangkokDateInput(selectedDateKey);
  } catch {
    selectedDayStart = startOfBangkokDay(now);
  }
  const selectedDayEnd = new Date(selectedDayStart.getTime() + DAY_MS);

  // Fetch sales, expenses, and shifts
  const [sales, expenses, shifts, currentShift] = await Promise.all([
    fetchSales(selectedDayStart, selectedDayEnd),
    fetchExpenses(selectedDayStart, selectedDayEnd),
    fetchCashShifts(30),
    fetchCurrentCashShift(),
  ]);

  const daySales = filterSales(sales, selectedDayStart, selectedDayEnd);
  const dayExpenses = filterExpenses(expenses, selectedDayStart, selectedDayEnd);
  const summary = summarize(daySales, dayExpenses);

  // Filter cash-specific records for audit
  const cashSalesList = daySales.filter((s) => s.payments.some((p) => p.method === "cash"));
  const cashExpensesList = dayExpenses.filter((e) => (e.paymentMethod ?? "cash") === "cash");

  // Find shift recorded for this selected day if any
  const shiftForDay = shifts.find((s) => s.shiftDate === selectedDateKey);
  const activeShift = currentShift?.shiftDate === selectedDateKey ? currentShift : shiftForDay;

  const openingCash = activeShift ? activeShift.openingCash : 0;
  const cashSales = summary.payments.cash;
  const cashExpenses = summary.expensePayments.cash;
  const expectedCash = openingCash + cashSales - cashExpenses;

  const isClosed = activeShift?.status === "closed";

  return (
    <>
      <PageTitle
        eyebrow="การเงินหน้าร้าน"
        title="ตรวจนับเงินสด & ปิดกะ"
        description="ตรวจสอบเงินสดในเก๊ะ บันทึกเงินทอนเริ่มต้น และกระทบยอดขายจริงแบบเรียลไทม์"
        action={
          <form method="get" action="/cash-drawer" className="cash-date-filter">
            <label htmlFor="shift-date-picker">วันที่:</label>
            <input
              id="shift-date-picker"
              type="date"
              name="date"
              defaultValue={selectedDateKey}
              max={todayKey}
            />
            <button type="submit" className="secondary-button" style={{ minHeight: "34px", padding: "0 12px", fontSize: "12px" }}>
              ดู
            </button>
          </form>
        }
      />

      {/* Main summary stats for selected day */}
      <div className="stat-grid main-stats">
        <StatCard
          label="เงินทอนเริ่มต้น"
          value={formatBaht(openingCash)}
          detail={activeShift ? (isClosed ? "ปิดกะแล้ว" : "เปิดกะอยู่") : "ยังไม่ได้บันทึกเงินทอน"}
          tone="amber"
          icon={Coins}
        />
        <StatCard
          label="เงินสดที่ควรมีในเก๊ะ"
          value={formatBaht(expectedCash)}
          detail={`เงินทอน + รับสด ${formatBaht(cashSales)} − จ่ายสด ${formatBaht(cashExpenses)}`}
          tone="green"
          icon={Wallet}
        />
        <StatCard
          label="เงินสดที่นับได้จริง"
          value={activeShift?.actualCash !== null && activeShift?.actualCash !== undefined ? formatBaht(activeShift.actualCash) : "ยังไม่ได้นับ"}
          detail={
            activeShift?.difference !== null && activeShift?.difference !== undefined
              ? activeShift.difference === 0
                ? "✓ ตรงเป๊ะ ครบถ้วน"
                : activeShift.difference < 0
                  ? `ขาด ${formatBaht(Math.abs(activeShift.difference))}`
                  : `เกิน +${formatBaht(activeShift.difference)}`
              : "กรอกข้อมูลด้านล่างเพื่อนับ"
          }
          tone={
            activeShift?.difference !== null && activeShift?.difference !== undefined
              ? activeShift.difference === 0
                ? "green"
                : "amber"
              : "blue"
          }
        />
      </div>

      <div className="dashboard-grid">
        {/* Left Column: Interactive Cash Counter & Reconciliation */}
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>เครื่องมือนับเงินสด & ปิดกะ</h2>
              <p>
                {selectedDateKey === todayKey ? "วันนี้" : formatThaiShortDate(selectedDayStart)} ·{" "}
                {isClosed ? "ปิดกะเรียบร้อยแล้ว (สามารถนับใหม่เพื่ออัปเดตได้)" : "นับเงินในเก๊ะเพื่อตรวจสอบ"}
              </p>
            </div>
            {isClosed && (
              <span className="status success">
                <CheckCircle2 size={13} /> ปิดกะแล้ว
              </span>
            )}
          </div>

          <ActionForm action={closeCashShift} submitLabel={isClosed ? "บันทึกอัปเดตผลตรวจนับ" : "บันทึกปิดกะ / บันทึกผลนับเงิน"}>
            <input type="hidden" name="shift_date" value={selectedDateKey} />
            {activeShift && <input type="hidden" name="id" value={activeShift.id} />}

            {!activeShift && (
              <label>
                <span>เงินทอนเริ่มต้นวัน (บาท)</span>
                <input
                  name="opening_cash"
                  inputMode="decimal"
                  defaultValue={openingCash ? (openingCash / 100).toString() : ""}
                  placeholder="เช่น 1000"
                />
              </label>
            )}

            <CashCounter
              expectedCashSatang={expectedCash}
              initialActualSatang={activeShift?.actualCash}
              shiftId={activeShift?.id}
            />

            <label className="spaced-top">
              <span>หมายเหตุเพิ่มเติม (ถ้ามี)</span>
              <textarea
                name="notes"
                maxLength={300}
                rows={2}
                defaultValue={activeShift?.notes ?? ""}
                placeholder="เช่น เงินขาด 50 บาทเพราะทอนเหรียญผิด, ซื้อน้ำแข็งแต่ยังไม่ได้บิล"
              />
            </label>
          </ActionForm>
        </section>

        {/* Right Column: Opening Cash Setup & Quick Links */}
        <div className="cash-side-column">
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>{activeShift ? "แก้ไขเงินทอนเริ่มต้น" : "บันทึกเงินทอนตอนเปิดร้าน"}</h2>
                <p>ใส่เงินทอนตอนเช้าก่อนเริ่มขาย</p>
              </div>
            </div>

            <ActionForm
              action={openCashShift}
              submitLabel={activeShift ? "อัปเดตเงินทอน" : "เปิดกะ & บันทึกเงินทอน"}
              resetOnSuccess={false}
            >
              <input type="hidden" name="shift_date" value={selectedDateKey} />
              <label>
                <span>จำนวนเงินทอน (บาท)</span>
                <input
                  name="opening_cash"
                  inputMode="decimal"
                  required
                  defaultValue={openingCash ? (openingCash / 100).toString() : "1000"}
                  placeholder="เช่น 1000"
                />
              </label>
              <label>
                <span>หมายเหตุ</span>
                <input
                  name="notes"
                  maxLength={150}
                  defaultValue={activeShift?.notes ?? ""}
                  placeholder="เช่น แบงก์ 100 x 5 ใบ, แบงก์ 20 x 25 ใบ"
                />
              </label>
            </ActionForm>
          </section>

          {/* Quick Flow Breakdown */}
          <section className="panel spaced">
            <div className="panel-head">
              <div>
                <h2>สรุปกระแสเงินสด {formatThaiShortDate(selectedDayStart)}</h2>
                <p>แยกเงินสด vs เงินโอน</p>
              </div>
            </div>
            <div className="summary-row">
              <span>ยอดขายเงินสด</span>
              <strong>+{formatBaht(summary.payments.cash)}</strong>
            </div>
            <div className="summary-row">
              <span>จ่ายค่าใช้จ่ายด้วยเงินสด</span>
              <strong>−{formatBaht(summary.expensePayments.cash)}</strong>
            </div>
            <div className="summary-row">
              <span>เงินทอนเริ่มต้น</span>
              <strong>+{formatBaht(openingCash)}</strong>
            </div>
            <div className="summary-total">
              <span>เงินสดที่ควรมีในเก๊ะ</span>
              <strong>{formatBaht(expectedCash)}</strong>
            </div>
            <div className="summary-row muted-row">
              <span>ยอดขายเงินโอน (เข้าบัญชี)</span>
              <span>+{formatBaht(summary.payments.transfer)}</span>
            </div>
            <div className="summary-row muted-row">
              <span>จ่ายค่าใช้จ่ายเงินโอน (ออกจากบัญชี)</span>
              <span>−{formatBaht(summary.expensePayments.transfer)}</span>
            </div>
            {summary.outstanding > 0 && (
              <div className="summary-row warning-row">
                <span>ค้างรับ (ยังไม่ได้เงิน)</span>
                <span>{formatBaht(summary.outstanding)}</span>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Cash Audit Logs: Detail of all Cash Sales and Cash Expenses of the day */}
      <div className="dashboard-grid lower spaced">
        <section className="panel table-panel">
          <div className="table-title">
            <div>
              <h2>บิลขายเงินสดของวันนี้</h2>
              <span>{cashSalesList.length} รายการ · รวม {formatBaht(cashSales)}</span>
            </div>
            <Link href="/sales" className="link-button small">
              ดูการขายทั้งหมด <ArrowRight size={14} />
            </Link>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>เวลา</th>
                <th>บิล</th>
                <th>ลูกค้า</th>
                <th className="num">ยอดเงินสด</th>
              </tr>
            </thead>
            <tbody>
              {cashSalesList.map((sale) => {
                const cashPart = sale.payments.find((p) => p.method === "cash")?.amount || 0;
                return (
                  <tr key={sale.id}>
                    <td>{formatTime(sale.soldAt)}</td>
                    <td><strong>#{sale.saleNumber}</strong></td>
                    <td>{sale.customerName || "ลูกค้าทั่วไป"}</td>
                    <td className="num"><strong>{formatBaht(cashPart)}</strong></td>
                  </tr>
                );
              })}
              {!cashSalesList.length && (
                <tr>
                  <td colSpan={4}>
                    <div className="empty-state">ยังไม่มีรายการขายเงินสดในวันนี้</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="panel table-panel">
          <div className="table-title">
            <div>
              <h2>บิลจ่ายเงินสดของวันนี้</h2>
              <span>{cashExpensesList.length} รายการ · รวม {formatBaht(cashExpenses)}</span>
            </div>
            <Link href="/expenses" className="link-button small">
              ดูค่าใช้จ่ายทั้งหมด <ArrowRight size={14} />
            </Link>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>รายการ</th>
                <th>หมวด</th>
                <th className="num">จำนวนเงิน</th>
              </tr>
            </thead>
            <tbody>
              {cashExpensesList.map((expense) => (
                <tr key={expense.id}>
                  <td>
                    <strong>{expense.description}</strong>
                    {expense.payee && <small className="block-muted">ผู้รับ: {expense.payee}</small>}
                  </td>
                  <td><span className="status muted">{expense.category}</span></td>
                  <td className="num negative"><strong>−{formatBaht(expense.amount)}</strong></td>
                </tr>
              ))}
              {!cashExpensesList.length && (
                <tr>
                  <td colSpan={3}>
                    <div className="empty-state">ยังไม่มีรายการจ่ายเงินสดในวันนี้</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>

      {/* Shift History Table */}
      <section className="panel table-panel spaced">
        <div className="table-title">
          <div>
            <h2>ประวัติการปิดกะ & ตรวจนับเงินสดย้อนหลัง</h2>
            <span>30 รายการล่าสุด</span>
          </div>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>วันที่</th>
              <th>เวลา</th>
              <th className="num">เงินทอน</th>
              <th className="num">ขายสด</th>
              <th className="num">จ่ายสด</th>
              <th className="num">ควรมี</th>
              <th className="num">นับจริง</th>
              <th className="num">ผลต่าง</th>
              <th>สถานะ</th>
              <th className="num">จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {shifts.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link href={`/cash-drawer?date=${s.shiftDate}`} className="text-link">
                    <strong>{s.shiftDate}</strong>
                  </Link>
                </td>
                <td>
                  <span className="shift-time">
                    {formatTime(s.openedAt)}
                    {s.closedAt ? ` – ${formatTime(s.closedAt)}` : " (เปิดอยู่)"}
                  </span>
                </td>
                <td className="num">{formatBaht(s.openingCash)}</td>
                <td className="num">{formatBaht(s.cashSales)}</td>
                <td className="num">{formatBaht(s.cashExpenses)}</td>
                <td className="num"><strong>{formatBaht(s.expectedCash)}</strong></td>
                <td className="num">
                  {s.actualCash !== null ? <strong>{formatBaht(s.actualCash)}</strong> : "—"}
                </td>
                <td className="num">
                  {s.difference !== null ? (
                    <span
                      className={`diff-tag ${
                        s.difference === 0 ? "match" : s.difference < 0 ? "shortage" : "surplus"
                      }`}
                    >
                      {s.difference === 0
                        ? "พอดี (฿0)"
                        : s.difference < 0
                          ? `ขาด ${formatBaht(Math.abs(s.difference))}`
                          : `เกิน +${formatBaht(s.difference)}`}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <span className={`status ${s.status === "closed" ? "success" : "pending"}`}>
                    {s.status === "closed" ? "ปิดกะแล้ว" : "เปิดกะอยู่"}
                  </span>
                </td>
                <td className="num">
                  <ActionButton
                    action={deleteCashShift}
                    fields={{ id: s.id }}
                    label="ลบ"
                    confirmText={`ต้องการลบรายการตรวจนับเงินสดวันที่ ${s.shiftDate} ใช่หรือไม่?`}
                    className="link-button danger"
                  />
                </td>
              </tr>
            ))}
            {!shifts.length && (
              <tr>
                <td colSpan={10}>
                  <div className="empty-state">ยังไม่มีประวัติการปิดกะ บันทึกกะแรกได้จากฟอร์มด้านบน</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
