import { beforeAll, describe, expect, it } from "vitest";
import { deriveVerifyOnlySubkey } from "../subkey.js";
import type { TokenPayload } from "../types.js";
import { NonceTracker, verifyToken } from "../verify.js";

const MASTER_KEY = "test-master-key-for-bundle-token-tests";

// --- Test-local mint helper ---
//
// bundle-token is verify-only by design. To roundtrip-test verify, we need
// to produce tokens. Rather than cross-import mint code (which lives in
// bundle-host), this test file implements a minimal local minter that
// derives a sign-capable subkey directly. This helper is test-only and
// does not leak into the package surface.

function base64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function deriveTestSignSubkey(masterKey: string, label: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterKey),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(label),
    },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

async function mintTestToken(
  opts: { agentId: string; sessionId: string; ttlMs?: number },
  subkey: CryptoKey,
): Promise<string> {
  const payload: TokenPayload = {
    aid: opts.agentId,
    sid: opts.sessionId,
    exp: Date.now() + (opts.ttlMs ?? 60_000),
    nonce: crypto.randomUUID(),
  };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(new TextEncoder().encode(payloadJson));
  const signature = await crypto.subtle.sign("HMAC", subkey, new TextEncoder().encode(payloadB64));
  const signatureB64 = base64urlEncode(signature);
  return `${payloadB64}.${signatureB64}`;
}

describe("bundle-token verify", () => {
  let spineSignSubkey: CryptoKey;
  let spineVerifySubkey: CryptoKey;
  let llmVerifySubkey: CryptoKey;

  beforeAll(async () => {
    spineSignSubkey = await deriveTestSignSubkey(MASTER_KEY, "claw/spine-v1");
    spineVerifySubkey = await deriveVerifyOnlySubkey(MASTER_KEY, "claw/spine-v1");
    llmVerifySubkey = await deriveVerifyOnlySubkey(MASTER_KEY, "claw/llm-v1");
  });

  describe("verifyToken", () => {
    it("verifies a valid token with the matching verify-only subkey", async () => {
      const token = await mintTestToken(
        { agentId: "agent-1", sessionId: "session-1" },
        spineSignSubkey,
      );
      const result = await verifyToken(token, spineVerifySubkey);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.payload.aid).toBe("agent-1");
        expect(result.payload.sid).toBe("session-1");
        expect(result.payload.exp).toBeGreaterThan(Date.now());
        expect(result.payload.nonce).toBeTruthy();
      }
    });

    it("rejects expired token", async () => {
      const token = await mintTestToken(
        { agentId: "agent-1", sessionId: "session-1", ttlMs: -1000 },
        spineSignSubkey,
      );
      const result = await verifyToken(token, spineVerifySubkey);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_TOKEN_EXPIRED");
      }
    });

    it("rejects tampered payload", async () => {
      const token = await mintTestToken(
        { agentId: "agent-1", sessionId: "session-1" },
        spineSignSubkey,
      );

      const [payloadB64, signature] = token.split(".");
      const payloadJson = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
      const payload = JSON.parse(payloadJson);
      payload.aid = "agent-EVIL";
      const tamperedPayload = btoa(JSON.stringify(payload))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const tamperedToken = `${tamperedPayload}.${signature}`;

      const result = await verifyToken(tamperedToken, spineVerifySubkey);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_BAD_TOKEN");
      }
    });

    it("rejects tampered signature", async () => {
      const token = await mintTestToken(
        { agentId: "agent-1", sessionId: "session-1" },
        spineSignSubkey,
      );

      const [payload] = token.split(".");
      const tamperedToken = `${payload}.AAAA_tampered_signature`;

      const result = await verifyToken(tamperedToken, spineVerifySubkey);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_BAD_TOKEN");
      }
    });

    it("rejects token verified with wrong-label subkey", async () => {
      const token = await mintTestToken(
        { agentId: "agent-1", sessionId: "session-1" },
        spineSignSubkey,
      );

      const result = await verifyToken(token, llmVerifySubkey);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_BAD_TOKEN");
      }
    });

    it("rejects malformed token (no dot separator)", async () => {
      const result = await verifyToken("no-dot-separator", spineVerifySubkey);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_MALFORMED");
      }
    });
  });

  describe("deriveVerifyOnlySubkey", () => {
    it("produces a key that cannot sign", async () => {
      const verifyOnly = await deriveVerifyOnlySubkey(MASTER_KEY, "claw/spine-v1");
      await expect(
        crypto.subtle.sign("HMAC", verifyOnly, new TextEncoder().encode("payload")),
      ).rejects.toThrow();
    });

    it("produces keys compatible with the same-label sign subkey", async () => {
      const token = await mintTestToken(
        { agentId: "agent-1", sessionId: "session-1" },
        spineSignSubkey,
      );
      const result = await verifyToken(token, spineVerifySubkey);
      expect(result.valid).toBe(true);
    });
  });

  describe("NonceTracker", () => {
    it("rejects replayed nonce", async () => {
      const tracker = new NonceTracker();
      const token = await mintTestToken(
        { agentId: "agent-1", sessionId: "session-1" },
        spineSignSubkey,
      );

      const first = await verifyToken(token, spineVerifySubkey, tracker);
      expect(first.valid).toBe(true);

      const second = await verifyToken(token, spineVerifySubkey, tracker);
      expect(second.valid).toBe(false);
      if (!second.valid) {
        expect(second.code).toBe("ERR_TOKEN_REPLAY");
      }
    });

    it("accepts distinct nonces", async () => {
      const tracker = new NonceTracker();

      const token1 = await mintTestToken(
        { agentId: "agent-1", sessionId: "session-1" },
        spineSignSubkey,
      );
      const token2 = await mintTestToken(
        { agentId: "agent-1", sessionId: "session-1" },
        spineSignSubkey,
      );

      const result1 = await verifyToken(token1, spineVerifySubkey, tracker);
      const result2 = await verifyToken(token2, spineVerifySubkey, tracker);

      expect(result1.valid).toBe(true);
      expect(result2.valid).toBe(true);
    });

    it("evicts expired nonces when near capacity", () => {
      const tracker = new NonceTracker(10);
      const now = Date.now();

      for (let i = 0; i < 9; i++) {
        tracker.tryConsume(`old-${i}`, now - 1000);
      }
      expect(tracker.size).toBe(9);

      const result = tracker.tryConsume("fresh", now + 60_000);
      expect(result).toBe(true);
      expect(tracker.size).toBe(1); // only the fresh one remains
    });

    it("rejects when at hard capacity with no expired entries", () => {
      const tracker = new NonceTracker(5);
      const futureExp = Date.now() + 300_000;

      for (let i = 0; i < 5; i++) {
        expect(tracker.tryConsume(`n-${i}`, futureExp)).toBe(true);
      }

      expect(tracker.tryConsume("overflow", futureExp)).toBe(false);
    });
  });
});
