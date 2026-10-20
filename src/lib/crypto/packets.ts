// Shared browser cryptographic packets keep video chunks and library key envelopes on one AES-GCM format.
import { credentialsSchema } from "@/lib/video/schema";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function getCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "Encryption requires a secure browser context with Web Crypto support.",
    );
  }
  return globalThis.crypto;
}

export function encodeBase64url(bytes: Uint8Array<ArrayBuffer>) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function decodeBase64url(value: string) {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64url(bytes) !== value)
    throw new Error("Invalid canonical base64url encoding.");
  return bytes;
}

export function randomKey() {
  return encodeBase64url(getCrypto().getRandomValues(new Uint8Array(32)));
}

async function importKey(value: string, usage: "encrypt" | "decrypt") {
  const parsed = credentialsSchema.shape.key.parse(value);
  return getCrypto().subtle.importKey(
    "raw",
    decodeBase64url(parsed),
    "AES-GCM",
    false,
    [usage],
  );
}

export async function encryptPacket(
  plaintext: ArrayBuffer,
  additionalData: Uint8Array<ArrayBuffer>,
  key: string,
) {
  const crypto = getCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: TAG_LENGTH * 8 },
    await importKey(key, "encrypt"),
    plaintext,
  );
  const packet = new Uint8Array(IV_LENGTH + encrypted.byteLength);
  packet.set(iv);
  packet.set(new Uint8Array(encrypted), IV_LENGTH);
  return packet.buffer;
}

export async function decryptPacket(
  packet: ArrayBuffer,
  additionalData: Uint8Array<ArrayBuffer>,
  key: string,
) {
  if (packet.byteLength < IV_LENGTH + TAG_LENGTH)
    throw new Error("Encrypted data packet is truncated.");
  const cryptoKey = await importKey(key, "decrypt");
  try {
    return await getCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: packet.slice(0, IV_LENGTH),
        additionalData,
        tagLength: TAG_LENGTH * 8,
      },
      cryptoKey,
      packet.slice(IV_LENGTH),
    );
  } catch {
    throw new Error(
      "Encrypted data authentication failed. Check the library key and try again.",
    );
  }
}
