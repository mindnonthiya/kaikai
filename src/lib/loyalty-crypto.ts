import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import fs from "fs";
import path from "path";

const ENCRYPTED_PREFIX = "enc:v1:";

function resolveRawServerSecret(): string {
  const envSecret = (
    process.env.LOYALTY_SERVER_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.OCR_API_KEY ??
    process.env.GEMINI_API_KEY ??
    ""
  ).trim();

  if (envSecret) return envSecret;

  try {
    const cwd = process.cwd();
    const envPaths = [
      path.join(cwd, ".env.local"),
      path.join(cwd, ".env.cloud"),
      path.join(cwd, ".env"),
    ];
    for (const p of envPaths) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf-8");
        const match = content.match(
          /^\s*(?:LOYALTY_SERVER_SECRET|SUPABASE_SERVICE_ROLE_KEY|OCR_API_KEY|GEMINI_API_KEY)\s*=\s*([^\r\n#]+)/m,
        );
        if (match && match[1]?.trim()) {
          return match[1].trim().replace(/^["']|["']$/g, "");
        }
      }
    }
  } catch {
    // Ignore fs errors in edge/browser environments
  }

  return "kaikai-default-server-secret-v1";
}

function deriveAesKey(): Buffer {
  const raw = resolveRawServerSecret();
  return createHash("sha256").update(`kaikai:loyalty:aes:${raw}`, "utf8").digest();
}

export function getLoyaltyServerKeyHash(): string {
  const raw = resolveRawServerSecret();
  return createHash("sha256").update(`kaikai:loyalty:auth:${raw}`, "utf8").digest("hex");
}

export function isEncryptedLoyaltySecret(value: string): boolean {
  return value.trim().startsWith(ENCRYPTED_PREFIX);
}

export function encryptLoyaltySecret(plainText: string): string {
  const trimmed = plainText.trim();
  if (!trimmed) return "";
  if (isEncryptedLoyaltySecret(trimmed)) return trimmed;

  const key = deriveAesKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(trimmed, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptLoyaltySecret(storedValue: string): string {
  const trimmed = (storedValue ?? "").trim();
  if (!trimmed) return "";
  if (!isEncryptedLoyaltySecret(trimmed)) {
    return trimmed;
  }

  try {
    const payload = trimmed.slice(ENCRYPTED_PREFIX.length);
    const [ivHex, tagHex, cipherHex] = payload.split(":");
    if (!ivHex || !tagHex || !cipherHex) return "";

    const key = deriveAesKey();
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(tagHex, "hex");
    const encrypted = Buffer.from(cipherHex, "hex");

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return "";
  }
}
