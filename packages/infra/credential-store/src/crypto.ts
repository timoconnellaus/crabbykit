/**
 * AES-256-GCM encryption/decryption for credential storage.
 * Uses Web Crypto API (available in both Workers and Node.js).
 */

/** Encrypt plaintext with AES-256-GCM. Returns base64 ciphertext and IV. */
export async function encrypt(
  keyBase64: string,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const keyBytes = base64ToBytes(keyBase64);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    encoded.buffer as ArrayBuffer,
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
  };
}

/** Decrypt AES-256-GCM ciphertext. Returns plaintext string. */
export async function decrypt(
  keyBase64: string,
  ciphertextBase64: string,
  ivBase64: string,
): Promise<string> {
  const keyBytes = base64ToBytes(keyBase64);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const iv = base64ToBytes(ivBase64);
  const ciphertext = base64ToBytes(ciphertextBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer,
  );

  return new TextDecoder().decode(decrypted);
}

/** Generate a random 256-bit key as base64. */
export function generateKey(): string {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(key);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
