import { describe, expect, it } from "vitest";
import { decrypt, encrypt, generateKey } from "@claw-for-cloudflare/credential-store";

describe("crypto", () => {
  it("generateKey returns a base64 string", () => {
    const key = generateKey();
    expect(key).toBeTruthy();
    // 32 bytes = 44 base64 chars (with padding)
    expect(atob(key).length).toBe(32);
  });

  it("encrypt returns ciphertext and iv", async () => {
    const key = generateKey();
    const result = await encrypt(key, "hello world");
    expect(result.ciphertext).toBeTruthy();
    expect(result.iv).toBeTruthy();
    // Ciphertext should be different from plaintext
    expect(atob(result.ciphertext)).not.toBe("hello world");
  });

  it("decrypt recovers original plaintext", async () => {
    const key = generateKey();
    const { ciphertext, iv } = await encrypt(key, "secret data 123");
    const decrypted = await decrypt(key, ciphertext, iv);
    expect(decrypted).toBe("secret data 123");
  });

  it("handles empty string", async () => {
    const key = generateKey();
    const { ciphertext, iv } = await encrypt(key, "");
    const decrypted = await decrypt(key, ciphertext, iv);
    expect(decrypted).toBe("");
  });

  it("handles unicode", async () => {
    const key = generateKey();
    const text = "こんにちは 🌍 émojis";
    const { ciphertext, iv } = await encrypt(key, text);
    const decrypted = await decrypt(key, ciphertext, iv);
    expect(decrypted).toBe(text);
  });

  it("different encryptions produce different ciphertexts (unique IV)", async () => {
    const key = generateKey();
    const r1 = await encrypt(key, "same text");
    const r2 = await encrypt(key, "same text");
    expect(r1.ciphertext).not.toBe(r2.ciphertext);
    expect(r1.iv).not.toBe(r2.iv);
  });

  it("wrong key fails to decrypt", async () => {
    const key1 = generateKey();
    const key2 = generateKey();
    const { ciphertext, iv } = await encrypt(key1, "secret");
    await expect(decrypt(key2, ciphertext, iv)).rejects.toThrow();
  });
});
