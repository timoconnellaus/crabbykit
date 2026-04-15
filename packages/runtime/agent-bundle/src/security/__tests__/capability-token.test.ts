import { beforeAll, describe, expect, it } from "vitest";
import {
  deriveSubkey,
  deriveVerifyOnlySubkey,
  mintToken,
  NonceTracker,
  verifyToken,
} from "../capability-token.js";

const MASTER_KEY = "test-master-key-for-capability-token-tests";

describe("capability-token", () => {
  let spineSubkey: CryptoKey;
  let llmSubkey: CryptoKey;

  beforeAll(async () => {
    spineSubkey = await deriveSubkey(MASTER_KEY, "claw/spine-v1");
    llmSubkey = await deriveSubkey(MASTER_KEY, "claw/llm-v1");
  });

  describe("mintToken + verifyToken roundtrip", () => {
    it("mints and verifies a valid token", async () => {
      const token = await mintToken({ agentId: "agent-1", sessionId: "session-1" }, spineSubkey);
      const result = await verifyToken(token, spineSubkey);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.payload.aid).toBe("agent-1");
        expect(result.payload.sid).toBe("session-1");
        expect(result.payload.exp).toBeGreaterThan(Date.now());
        expect(result.payload.nonce).toBeTruthy();
      }
    });

    it("rejects expired token", async () => {
      const token = await mintToken(
        { agentId: "agent-1", sessionId: "session-1", ttlMs: -1000 },
        spineSubkey,
      );
      const result = await verifyToken(token, spineSubkey);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_TOKEN_EXPIRED");
      }
    });

    it("rejects tampered payload", async () => {
      const token = await mintToken({ agentId: "agent-1", sessionId: "session-1" }, spineSubkey);

      // Tamper with the payload by replacing agent ID
      const [payloadB64, signature] = token.split(".");
      const payloadJson = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
      const payload = JSON.parse(payloadJson);
      payload.aid = "agent-EVIL";
      const tamperedPayload = btoa(JSON.stringify(payload))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const tamperedToken = `${tamperedPayload}.${signature}`;

      const result = await verifyToken(tamperedToken, spineSubkey);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_BAD_TOKEN");
      }
    });

    it("rejects tampered signature", async () => {
      const token = await mintToken({ agentId: "agent-1", sessionId: "session-1" }, spineSubkey);

      const [payload] = token.split(".");
      const tamperedToken = `${payload}.AAAA_tampered_signature`;

      const result = await verifyToken(tamperedToken, spineSubkey);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_BAD_TOKEN");
      }
    });

    it("rejects token verified with wrong subkey", async () => {
      const token = await mintToken({ agentId: "agent-1", sessionId: "session-1" }, spineSubkey);

      // Verify with LLM subkey instead of spine subkey
      const result = await verifyToken(token, llmSubkey);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_BAD_TOKEN");
      }
    });

    it("rejects malformed token (no dot separator)", async () => {
      const result = await verifyToken("no-dot-separator", spineSubkey);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_MALFORMED");
      }
    });
  });

  describe("replay protection", () => {
    it("rejects replayed nonce", async () => {
      const tracker = new NonceTracker();
      const token = await mintToken({ agentId: "agent-1", sessionId: "session-1" }, spineSubkey);

      const first = await verifyToken(token, spineSubkey, tracker);
      expect(first.valid).toBe(true);

      const second = await verifyToken(token, spineSubkey, tracker);
      expect(second.valid).toBe(false);
      if (!second.valid) {
        expect(second.code).toBe("ERR_TOKEN_REPLAY");
      }
    });

    it("accepts different nonces", async () => {
      const tracker = new NonceTracker();

      const token1 = await mintToken({ agentId: "agent-1", sessionId: "session-1" }, spineSubkey);
      const token2 = await mintToken({ agentId: "agent-1", sessionId: "session-1" }, spineSubkey);

      const result1 = await verifyToken(token1, spineSubkey, tracker);
      const result2 = await verifyToken(token2, spineSubkey, tracker);

      expect(result1.valid).toBe(true);
      expect(result2.valid).toBe(true);
    });
  });

  describe("HKDF subkey derivation", () => {
    it("produces distinct subkeys for different labels", async () => {
      // We can't directly compare CryptoKey objects, but we can verify
      // that a token signed with one subkey doesn't verify with the other
      const token = await mintToken({ agentId: "agent-1", sessionId: "session-1" }, spineSubkey);

      const spineResult = await verifyToken(token, spineSubkey);
      const llmResult = await verifyToken(token, llmSubkey);

      expect(spineResult.valid).toBe(true);
      expect(llmResult.valid).toBe(false);
    });

    it("produces the same subkey for the same label", async () => {
      const key1 = await deriveSubkey(MASTER_KEY, "claw/spine-v1");
      const key2 = await deriveSubkey(MASTER_KEY, "claw/spine-v1");

      // Sign with key1, verify with key2 — should succeed if they're identical
      const token = await mintToken({ agentId: "a", sessionId: "s" }, key1);
      const result = await verifyToken(token, key2);
      expect(result.valid).toBe(true);
    });

    it("verify-only subkey can verify but not sign", async () => {
      const verifyOnly = await deriveVerifyOnlySubkey(MASTER_KEY, "claw/spine-v1");

      // Verify should work
      const token = await mintToken({ agentId: "agent-1", sessionId: "session-1" }, spineSubkey);
      const result = await verifyToken(token, verifyOnly);
      expect(result.valid).toBe(true);

      // Signing should throw
      await expect(mintToken({ agentId: "a", sessionId: "s" }, verifyOnly)).rejects.toThrow();
    });
  });

  describe("NonceTracker", () => {
    it("evicts expired nonces when near capacity", () => {
      const tracker = new NonceTracker(10);
      const now = Date.now();

      // Fill with expired nonces
      for (let i = 0; i < 9; i++) {
        tracker.tryConsume(`old-${i}`, now - 1000);
      }
      expect(tracker.size).toBe(9);

      // Add a fresh one — should trigger eviction
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

      // 6th should be rejected
      expect(tracker.tryConsume("overflow", futureExp)).toBe(false);
    });
  });
});
