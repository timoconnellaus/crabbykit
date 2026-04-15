import {
  deriveVerifyOnlySubkey,
  NonceTracker,
  verifyToken,
} from "@claw-for-cloudflare/bundle-token";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveMintSubkey, mintToken } from "../mint.js";

const MASTER_KEY = "test-master-key-for-bundle-host-mint-tests";

describe("bundle-host mint", () => {
  let spineMintSubkey: CryptoKey;
  let spineVerifySubkey: CryptoKey;
  let llmVerifySubkey: CryptoKey;

  beforeAll(async () => {
    spineMintSubkey = await deriveMintSubkey(MASTER_KEY, "claw/spine-v1");
    spineVerifySubkey = await deriveVerifyOnlySubkey(MASTER_KEY, "claw/spine-v1");
    llmVerifySubkey = await deriveVerifyOnlySubkey(MASTER_KEY, "claw/llm-v1");
  });

  describe("mintToken + verifyToken roundtrip", () => {
    it("mints and verifies a valid token", async () => {
      const token = await mintToken(
        { agentId: "agent-1", sessionId: "session-1" },
        spineMintSubkey,
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
      const token = await mintToken(
        { agentId: "agent-1", sessionId: "session-1", ttlMs: -1000 },
        spineMintSubkey,
      );
      const result = await verifyToken(token, spineVerifySubkey);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_TOKEN_EXPIRED");
      }
    });

    it("rejects token verified with wrong-label subkey", async () => {
      const token = await mintToken(
        { agentId: "agent-1", sessionId: "session-1" },
        spineMintSubkey,
      );

      const result = await verifyToken(token, llmVerifySubkey);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_BAD_TOKEN");
      }
    });
  });

  describe("deriveMintSubkey", () => {
    it("produces a key that cannot verify", async () => {
      const mintOnly = await deriveMintSubkey(MASTER_KEY, "claw/spine-v1");
      const encoder = new TextEncoder();
      await expect(
        crypto.subtle.verify("HMAC", mintOnly, encoder.encode("sig"), encoder.encode("payload")),
      ).rejects.toThrow();
    });

    it("produces the same HKDF output for the same label (roundtrip via verify-only sibling)", async () => {
      const mintA = await deriveMintSubkey(MASTER_KEY, "claw/spine-v1");
      const token = await mintToken({ agentId: "a", sessionId: "s" }, mintA);
      const result = await verifyToken(token, spineVerifySubkey);
      expect(result.valid).toBe(true);
    });
  });

  describe("NonceTracker roundtrip", () => {
    it("rejects replayed mint output", async () => {
      const tracker = new NonceTracker();
      const token = await mintToken(
        { agentId: "agent-1", sessionId: "session-1" },
        spineMintSubkey,
      );

      const first = await verifyToken(token, spineVerifySubkey, tracker);
      expect(first.valid).toBe(true);

      const second = await verifyToken(token, spineVerifySubkey, tracker);
      expect(second.valid).toBe(false);
      if (!second.valid) {
        expect(second.code).toBe("ERR_TOKEN_REPLAY");
      }
    });
  });
});
