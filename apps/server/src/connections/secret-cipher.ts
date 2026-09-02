import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type ProtectedHeaderMap = Record<string, string>;

export type SecretCipherErrorCode = "CONNECTION_KEY_UNAVAILABLE" | "CONNECTION_SECRET_INVALID";

export class SecretCipherError extends Error {
  constructor(
    readonly code: SecretCipherErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SecretCipherError";
  }
}

export interface SecretCipher {
  readonly available: boolean;
  encrypt(profileId: string, headers: ProtectedHeaderMap): string;
  decrypt(profileId: string, envelope: string): ProtectedHeaderMap;
}

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function additionalData(profileId: string): Buffer {
  return Buffer.from(`canvas-drop:connection-profile:${profileId}`, "utf8");
}

function decodeKey(configuredKey: string | undefined): Buffer | undefined {
  if (!configuredKey || !/^[A-Za-z0-9+/]+={0,2}$/.test(configuredKey)) return undefined;
  const key = Buffer.from(configuredKey, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== configuredKey) return undefined;
  return key;
}

function unavailable(): never {
  throw new SecretCipherError(
    "CONNECTION_KEY_UNAVAILABLE",
    "connection protected headers require a valid encryption key",
  );
}

function invalid(): never {
  throw new SecretCipherError(
    "CONNECTION_SECRET_INVALID",
    "connection protected headers could not be decrypted",
  );
}

function parseHeaders(value: unknown): ProtectedHeaderMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const headers: ProtectedHeaderMap = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") invalid();
    headers[name] = headerValue;
  }
  return headers;
}

export function createSecretCipher(configuredKey: string | undefined): SecretCipher {
  const key = decodeKey(configuredKey);
  return {
    available: key !== undefined,
    encrypt(profileId, headers) {
      if (!key) unavailable();
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(additionalData(profileId));
      const payload = Buffer.from(JSON.stringify(headers), "utf8");
      const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
    decrypt(profileId, envelope) {
      if (!key) unavailable();
      try {
        const [version, ivText, tagText, ciphertextText, extra] = envelope.split(".");
        if (version !== VERSION || !ivText || !tagText || !ciphertextText || extra) invalid();
        const iv = Buffer.from(ivText, "base64url");
        const tag = Buffer.from(tagText, "base64url");
        if (iv.byteLength !== IV_BYTES || tag.byteLength !== TAG_BYTES) invalid();
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(additionalData(profileId));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(ciphertextText, "base64url")),
          decipher.final(),
        ]);
        return parseHeaders(JSON.parse(plaintext.toString("utf8")));
      } catch (error) {
        if (error instanceof SecretCipherError) throw error;
        invalid();
      }
    },
  };
}
