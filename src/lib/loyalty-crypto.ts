import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "crypto";
import fs from "fs";
import path from "path";

const ENCRYPTED_V2_PREFIX = "enc:v2:";
const ENCRYPTED_V1_PREFIX = "enc:v1:";

let ephemeralTestSecret = "";

function readEnvFileVar(varNames: string[]): string {
  try {
    const cwd = process.cwd();
    const envPaths = [
      path.join(cwd, ".env.local"),
      path.join(cwd, ".env.cloud"),
      path.join(cwd, ".env"),
    ];
    const pattern = new RegExp(
      `^\\s*(?:${varNames.join("|")})\\s*=\\s*([^\\r\\n#]+)`,
      "m",
    );
    for (const p of envPaths) {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf-8");
        const match = content.match(pattern);
        if (match && match[1]?.trim()) {
          return match[1].trim().replace(/^["']|["']$/g, "");
        }
      }
    }
  } catch {
    // Ignore fs errors in edge/browser environments
  }
  return "";
}

/**
 * Resolves the dedicated Loyalty encryption secret.
 * Never depends on OCR_API_KEY or GEMINI_API_KEY so rotating slip-reader API keys
 * never invalidates encrypted LINE tokens, and never falls back to a hardcoded string in code.
 */
function resolvePrimaryLoyaltySecret(): string {
  const envSecret = (
    process.env.LOYALTY_SERVER_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    ""
  ).trim();
  if (envSecret) return envSecret;

  const fileSecret = readEnvFileVar(["LOYALTY_SERVER_SECRET", "SUPABASE_SERVICE_ROLE_KEY"]);
  if (fileSecret) return fileSecret;

  if (process.env.NODE_ENV === "test" || Boolean(process.env.VITEST)) {
    if (!ephemeralTestSecret) {
      ephemeralTestSecret = randomBytes(32).toString("hex");
    }
    return ephemeralTestSecret;
  }

  return "";
}

function resolveLegacyV1Secret(): string {
  const envLegacy = (process.env.OCR_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();
  if (envLegacy) return envLegacy;
  return readEnvFileVar(["OCR_API_KEY", "GEMINI_API_KEY"]);
}

export function hasLoyaltyServerSecret(): boolean {
  return resolvePrimaryLoyaltySecret().length >= 16;
}

export function resolveCronSecret(): string {
  if (process.env.CRON_SECRET !== undefined) {
    return process.env.CRON_SECRET.trim();
  }
  return readEnvFileVar(["CRON_SECRET"]);
}

/**
 * Strictly fail-closed verification for /api/loyalty/worker.
 * If CRON_SECRET is missing or shorter than 16 chars, always rejects external calls.
 */
export function verifyCronAuthorization(authHeader: string | null): {
  ok: boolean;
  configured: boolean;
} {
  const secret = resolveCronSecret();
  if (!secret || secret.length < 16) {
    return { ok: false, configured: false };
  }

  const header = (authHeader ?? "").trim();
  const expected = `Bearer ${secret}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(header, "utf8");
  if (expectedBuf.length !== actualBuf.length) {
    return { ok: false, configured: true };
  }

  return {
    ok: timingSafeEqual(expectedBuf, actualBuf),
    configured: true,
  };
}

function deriveAesKey(rawSecret: string): Buffer {
  return createHash("sha256").update(`kaikai:loyalty:aes:${rawSecret}`, "utf8").digest();
}

export function getLoyaltyServerKeyHash(): string {
  const raw = resolvePrimaryLoyaltySecret();
  if (!raw) return "";
  return createHash("sha256").update(`kaikai:loyalty:auth:${raw}`, "utf8").digest("hex");
}

export function getLegacyLoyaltyServerKeyHash(): string {
  const raw = resolveLegacyV1Secret();
  if (!raw) return "";
  return createHash("sha256").update(`kaikai:loyalty:auth:${raw}`, "utf8").digest("hex");
}

export function isEncryptedLoyaltySecret(value: string): boolean {
  const trimmed = (value ?? "").trim();
  return trimmed.startsWith(ENCRYPTED_V2_PREFIX) || trimmed.startsWith(ENCRYPTED_V1_PREFIX);
}

export function isCurrentVersionEncryptedSecret(value: string): boolean {
  return (value ?? "").trim().startsWith(ENCRYPTED_V2_PREFIX);
}

export function encryptLoyaltySecret(plainText: string): string {
  const trimmed = (plainText ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith(ENCRYPTED_V2_PREFIX)) return trimmed;

  // If input is a legacy v1 ciphertext, decrypt it first and re-encrypt with v2
  const actualPlain = trimmed.startsWith(ENCRYPTED_V1_PREFIX)
    ? decryptLoyaltySecret(trimmed)
    : trimmed;
  if (!actualPlain) return "";

  const secret = resolvePrimaryLoyaltySecret();
  if (!secret) {
    throw new Error(
      "Missing LOYALTY_SERVER_SECRET environment variable. Please set LOYALTY_SERVER_SECRET in your environment before saving LINE tokens.",
    );
  }

  const key = deriveAesKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(actualPlain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTED_V2_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function tryDecryptPayload(payload: string, key: Buffer): string | null {
  try {
    const [ivHex, tagHex, cipherHex] = payload.split(":");
    if (!ivHex || !tagHex || !cipherHex) return null;

    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(tagHex, "hex");
    const encrypted = Buffer.from(cipherHex, "hex");

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

export function decryptLoyaltySecret(storedValue: string): string {
  const trimmed = (storedValue ?? "").trim();
  if (!trimmed) return "";

  const primarySecret = resolvePrimaryLoyaltySecret();

  if (trimmed.startsWith(ENCRYPTED_V2_PREFIX)) {
    if (!primarySecret) return "";
    const payload = trimmed.slice(ENCRYPTED_V2_PREFIX.length);
    return tryDecryptPayload(payload, deriveAesKey(primarySecret)) ?? "";
  }

  if (trimmed.startsWith(ENCRYPTED_V1_PREFIX)) {
    const payload = trimmed.slice(ENCRYPTED_V1_PREFIX.length);
    if (primarySecret) {
      const fromPrimary = tryDecryptPayload(payload, deriveAesKey(primarySecret));
      if (fromPrimary) return fromPrimary;
    }
    const legacySecret = resolveLegacyV1Secret();
    if (legacySecret) {
      const fromLegacy = tryDecryptPayload(payload, deriveAesKey(legacySecret));
      if (fromLegacy) return fromLegacy;
    }
    return "";
  }

  return trimmed;
}
