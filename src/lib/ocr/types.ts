export type OcrStatus = "pending" | "processing" | "needs_review" | "confirmed" | "failed";

export type OcrResult = {
  amountSatang?: number;
  transferredAt?: string;
  bank?: string;
  referenceNumber?: string;
  senderName?: string;
  receiverName?: string;
  confidence?: number;
};

export interface OcrProvider {
  readonly name: string;
  readSlip(file: ArrayBuffer, mimeType?: string): Promise<OcrResult>;
}

import { GeminiOcrProvider } from "./gemini";

export function getOcrProvider(): OcrProvider | null {
  const provider = (process.env.OCR_PROVIDER ?? "").toLowerCase().trim();
  const apiKey = (process.env.OCR_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();

  if (!apiKey) return null;

  if (provider === "gemini" || !provider || apiKey.startsWith("AIza")) {
    return new GeminiOcrProvider(apiKey);
  }

  return null;
}

