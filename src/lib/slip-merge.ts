import { formatBaht } from "@/lib/money";

export type ExtraSlipPart = {
  id: string;
  sourceFile: File;
  compressedFile?: File;
  previewUrl: string;
  hash: string;
  originalBytes: number;
  compressedBytes: number;
  amountSatang: number;
  transferredAt?: string;
  bank?: string;
  referenceNumber?: string;
  isDuplicate?: boolean;
  duplicateReason?: string;
};

/**
 * Sums integer satang across a primary slip and any additional attached slips.
 */
export function sumSlipAmountsSatang(
  primaryAmountSatang: number,
  extraSlips: ReadonlyArray<{ amountSatang: number }> = []
): number {
  const base = Number.isFinite(primaryAmountSatang) ? Math.max(0, Math.round(primaryAmountSatang)) : 0;
  const extraTotal = extraSlips.reduce((sum, part) => {
    const val = Number.isFinite(part.amountSatang) ? Math.max(0, Math.round(part.amountSatang)) : 0;
    return sum + val;
  }, 0);
  return base + extraTotal;
}

/**
 * Collects unique non-empty reference numbers across primary and extra slips in order.
 */
export function collectSlipReferenceNumbers(
  primaryRef?: string | null,
  extraSlips: ReadonlyArray<{ referenceNumber?: string | null }> = []
): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  const candidates = [primaryRef, ...extraSlips.map((s) => s.referenceNumber)];
  for (const raw of candidates) {
    const clean = (raw ?? "").trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      refs.push(clean);
    }
  }
  return refs;
}

/**
 * Formats a concise human-readable note when multiple slips are combined into a single order.
 * Returns null if there are no extra slips.
 */
export function formatMultiSlipBreakdownNote(
  primaryAmountSatang: number,
  extraSlips: ReadonlyArray<{ amountSatang: number }> = []
): string | null {
  if (!extraSlips || extraSlips.length === 0) return null;
  const allAmounts = [
    Math.max(0, Math.round(primaryAmountSatang)),
    ...extraSlips.map((s) => Math.max(0, Math.round(s.amountSatang))),
  ];
  const totalSatang = allAmounts.reduce((sum, a) => sum + a, 0);
  const partsText = allAmounts.map((a) => formatBaht(a)).join(" + ");
  return `รวม ${allAmounts.length} สลิป (${partsText} = ${formatBaht(totalSatang)})`;
}
