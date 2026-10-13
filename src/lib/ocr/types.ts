export type OcrStatus = "pending" | "processing" | "needs_review" | "confirmed" | "failed";

export type OcrResult = {
  amountSatang?: number;
  transferredAt?: string;
  bank?: string;
  referenceNumber?: string;
  confidence?: number;
};

export interface OcrProvider {
  readonly name: string;
  readSlip(file: ArrayBuffer): Promise<OcrResult>;
}

export function getOcrProvider(): OcrProvider | null {
  // MVP deliberately has no fake OCR. Add a server-only adapter after selecting a provider.
  return null;
}
