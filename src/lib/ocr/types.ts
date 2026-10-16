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

import fs from "fs";
import path from "path";
import { GeminiOcrProvider } from "./gemini";

function resolveApiKey(): { provider: string; apiKey: string } {
  let provider = (process.env.OCR_PROVIDER ?? "").toLowerCase().trim();
  let apiKey = (process.env.OCR_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();

  if (apiKey) return { provider, apiKey };

  // Fallback: Read directly from .env.local or .env.cloud if process.env wasn't restarted
  try {
    const cwd = process.cwd();
    const envPaths = [path.join(cwd, ".env.local"), path.join(cwd, ".env.cloud"), path.join(cwd, ".env")];
    for (const p of envPaths) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf-8");
        const keyMatch = content.match(/OCR_API_KEY\s*=\s*(.+)/);
        const provMatch = content.match(/OCR_PROVIDER\s*=\s*(.+)/);
        if (keyMatch && keyMatch[1]?.trim()) {
          apiKey = keyMatch[1].trim().replace(/^["']|["']$/g, "");
          if (provMatch && provMatch[1]?.trim()) {
            provider = provMatch[1].trim().replace(/^["']|["']$/g, "").toLowerCase();
          }
          if (apiKey) break;
        }
      }
    }
  } catch {
    // Ignore fs errors in non-node environments
  }

  return { provider, apiKey };
}

export function getOcrProvider(): OcrProvider | null {
  const { provider, apiKey } = resolveApiKey();

  if (!apiKey) return null;

  if (provider === "gemini" || !provider || apiKey.startsWith("AIza") || apiKey.startsWith("AQ.")) {
    return new GeminiOcrProvider(apiKey);
  }

  return null;
}

