/**
 * Slip duplicate detection helpers.
 * Ensures duplicate detection NEVER relies on amounts,
 * but strictly on unique bank transaction references and file hashes.
 */

export interface SlipIdentifier {
  id?: string;
  hash?: string;
  referenceNumber?: string;
}

export interface DuplicateDetectionResult {
  isDuplicate: boolean;
  reason?: string;
}

/**
 * Checks if a slip is duplicate within a batch of uploaded slips.
 * A slip is considered duplicate within the batch if:
 * 1. It shares an identical bank reference number (length >= 6) with another slip.
 * 2. It shares an identical file hash (SHA-256) with another slip.
 *
 * Price/Amount is INTENTIONALLY NOT CHECKED here, because legitimate distinct customers
 * frequently transfer the exact same amount for the same menu/set.
 */
export function checkIntraBatchDuplicate(
  candidate: SlipIdentifier,
  existingSlips: SlipIdentifier[]
): DuplicateDetectionResult {
  const cleanRef = candidate.referenceNumber?.trim();
  const cleanHash = candidate.hash?.trim();

  for (const item of existingSlips) {
    if (candidate.id && item.id && candidate.id === item.id) {
      continue;
    }

    const itemRef = item.referenceNumber?.trim();
    if (cleanRef && cleanRef.length >= 6 && itemRef && cleanRef.toUpperCase() === itemRef.toUpperCase()) {
      return {
        isDuplicate: true,
        reason: `เลขอ้างอิง Ref: ${cleanRef} ซ้ำกับสลิปอีกใบในชุดนี้`,
      };
    }

    const itemHash = item.hash?.trim();
    if (cleanHash && cleanHash.length > 0 && itemHash && cleanHash === itemHash) {
      return {
        isDuplicate: true,
        reason: "ไฟล์รูปภาพนี้ซ้ำกับสลิปอีกใบในชุดนี้",
      };
    }
  }

  return { isDuplicate: false };
}
