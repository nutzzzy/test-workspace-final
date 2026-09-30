import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain: string, secretKey: string): string {
  const key = deriveKey(secretKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(payload: string, secretKey: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted secret format");
  }
  const key = deriveKey(secretKey);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** Display form of a stored secret. No characters of the value are revealed. */
export function maskValue(value: string): string {
  return value ? "***" : "";
}

/**
 * Legacy development default. Kept so secrets already encrypted with it stay
 * readable in local setups; never accepted in production.
 */
const LEGACY_DEV_KEY = "change-me-to-a-long-random-secret-key";
let warnedAboutDevKey = false;

/** The one place that decides which key encrypts secrets at rest. */
export function resolveEncryptionKey(configured: string | undefined): string {
  const key = configured?.trim();
  if (key) return key;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SECRETS_ENCRYPTION_KEY must be set in production");
  }
  if (!warnedAboutDevKey) {
    warnedAboutDevKey = true;
    console.warn(
      "SECRETS_ENCRYPTION_KEY is not set; secrets are encrypted with the public development key. Set it in .env.",
    );
  }
  return LEGACY_DEV_KEY;
}
