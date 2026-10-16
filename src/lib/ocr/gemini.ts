import type { OcrProvider, OcrResult } from "./types";

/**
 * Google Gemini Multimodal OCR provider for Thai bank transfer slips.
 * Works with Gemini 2.0 Flash or Gemini 1.5 Flash.
 */
export class GeminiOcrProvider implements OcrProvider {
  readonly name = "gemini";
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = "gemini-2.0-flash") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async readSlip(buffer: ArrayBuffer, mimeType: string = "image/webp"): Promise<OcrResult> {
    const base64Data = Buffer.from(buffer).toString("base64");
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const prompt = `You are a financial OCR expert specializing in Thai bank transfer slips (สลิปโอนเงิน).
Extract the following information from this image:
1. "amount": The exact transferred amount in Thai Baht (number, e.g. 84.00 or 114.50). Be very careful not to confuse balance remaining or fee with the transferred amount.
2. "date": The transfer date in YYYY-MM-DD format (if in Thai Buddhist year e.g. 2567 or 67, convert to Western year e.g. 2024, or 2568 -> 2025, 2569 -> 2026).
3. "time": The transfer time in HH:mm or HH:mm:ss format (24-hour).
4. "bank": The bank name/code (e.g. KBANK, SCB, KTB, BBL, BAY, GSB, TTB, PromptPay, TrueMoney).
5. "referenceNumber": The transaction / reference / transaction ID if present.
6. "senderName": Sender's name if visible.
7. "receiverName": Receiver's name if visible.

Return ONLY a valid JSON object with these keys:
{
  "amount": number,
  "date": "YYYY-MM-DD",
  "time": "HH:mm",
  "bank": string | null,
  "referenceNumber": string | null,
  "senderName": string | null,
  "receiverName": string | null
}
If any field cannot be determined, set it to null. Return strictly JSON, no markdown codeblocks, no other text.`;

    const requestBody = {
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType,
                data: base64Data,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errText = await res.text();
      // Try fallback to gemini-1.5-flash if 2.0-flash is unavailable
      if (this.model !== "gemini-1.5-flash" && (res.status === 404 || res.status === 400)) {
        const fallback = new GeminiOcrProvider(this.apiKey, "gemini-1.5-flash");
        return fallback.readSlip(buffer, mimeType);
      }
      throw new Error(`Gemini API error (${res.status}): ${errText}`);
    }

    const json = await res.json();
    const candidateText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidateText) throw new Error("Gemini returned empty response");

    const cleaned = candidateText.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned);

    const amount = typeof parsed.amount === "number" ? parsed.amount : parseFloat(String(parsed.amount || 0));
    const amountSatang = Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : undefined;

    let transferredAt: string | undefined;
    if (parsed.date) {
      const timeStr = parsed.time || "12:00:00";
      // Construct Bangkok time (+07:00)
      const dateTimeString = `${parsed.date}T${timeStr.length === 5 ? `${timeStr}:00` : timeStr}+07:00`;
      const d = new Date(dateTimeString);
      if (!isNaN(d.getTime())) {
        transferredAt = d.toISOString();
      }
    }

    return {
      amountSatang,
      transferredAt,
      bank: parsed.bank || undefined,
      referenceNumber: parsed.referenceNumber || undefined,
      confidence: 0.98,
    };
  }
}
