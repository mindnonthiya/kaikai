import type { PricePreset } from "@/lib/data/types";

/**
 * Strict 1:1 matching between a slip amount and saved price presets.
 * Only returns a preset if the amountSatang matches exactly.
 * Does NOT perform fuzzy matching, deductions (e.g. subtracting delivery fee), or heuristic guesses.
 */
export function matchPresetStrictly(
  amountSatang: number,
  presets: PricePreset[]
): PricePreset | null {
  if (!amountSatang || amountSatang <= 0) return null;
  return presets.find((p) => p.amountSatang === amountSatang) ?? null;
}
