import {
  NonceTracker,
  verifyToken,
  deriveVerifyOnlySubkey,
} from "@claw-for-cloudflare/bundle-token";
import { beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_SUBKEY_LABEL, deriveMintSubkey, mintToken } from "../mint.js";

const MASTER_KEY = "test-master-key-for-bundle-host-mint-tests";

describe("bundle-host mint", () => {
  let bundleMintSubkey: CryptoKey;
  let bundleVerifySubkey: CryptoKey;
  let otherVerifySubkey: CryptoKey;

  beforeAll(async () => {
    bundleMintSubkey = await deriveMintSubkey(MASTER_KEY, BUNDLE_SUBKEY_LABEL);
    bundleVerifySubkey = await deriveVerifyOnlySubkey(MASTER_KEY, BUNDLE_SUBKEY_LABEL);
    otherVerifySubkey = await deriveVerifyOnlySubkey(MASTER_KEY, "claw/other-v1");
  });

  describe("mintToken + verifyToken roundtrip", () => {
    it("mints and verifies a valid token with scope", async () => {
      const token = await mintToken(
        { agentId: "agent-1", sessionId: "session-1", scope: ["spine", "llm"] },
        bundleMintSubkey,
      );
      const result = await verifyToken(token, bundleVerifySubkey);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.payload.aid).toBe("agent-1");
        expect(result.payload.sid).toBe("session-1");
        expect(result.payload.exp).toBeGreaterThan(Date.now());
        expect(result.payload.nonce).toBeTruthy();
        expect(result.payload.scope).toEqual(["spine", "llm"]);
      }
    });

    it("verifies with requiredScope when scope includes it", async () => {
      const token = await mintToken(
        { agentId: "a", sessionId: "s", scope: ["spine", "llm", "tavily-web-search"] },
        bundleMintSubkey,
      );
      const result = await verifyToken(token, bundleVerifySubkey, {
        requiredScope: "tavily-web-search",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects with ERR_SCOPE_DENIED when scope excludes requiredScope", async () => {
      const token = await mintToken(
        { agentId: "a", sessionId: "s", scope: ["spine", "llm"] },
        bundleMintSubkey,
      );
      const result = await verifyToken(token, bundleVerifySubkey, {
        requiredScope: "tavily-web-search",
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_SCOPE_DENIED");
      }
    });

    it("rejects expired token", async () => {
      const token = await mintToken(
        { agentId: "agent-1", sessionId: "session-1", scope: ["spine"], ttlMs: -1000 },
        bundleMintSubkey,
      );
      const result = await verifyToken(token, bundleVerifySubkey);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_TOKEN_EXPIRED");
      }
    });

    it("rejects token verified with wrong-label subkey", async () => {
      const token = await mintToken(
        { agentId: "agent-1", sessionId: "session-1", scope: ["spine"] },
        bundleMintSubkey,
      );

      const result = await verifyToken(token, otherVerifySubkey);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.code).toBe("ERR_BAD_TOKEN");
      }
    });
  });

  describe("deriveMintSubkey", () => {
    it("produces a key that cannot verify", async () => {
      const mintOnly = await deriveMintSubkey(MASTER_KEY, BUNDLE_SUBKEY_LABEL);
      const encoder = new TextEncoder();
      await expect(
        crypto.subtle.verify("HMAC", mintOnly, encoder.encode("sig"), encoder.encode("payload")),
      ).rejects.toThrow();
    });

    it("produces the same HKDF output for the same label (roundtrip via verify-only sibling)", async () => {
      const mintA = await deriveMintSubkey(MASTER_KEY, BUNDLE_SUBKEY_LABEL);
      const token = await mintToken({ agentId: "a", sessionId: "s", scope: ["spine"] }, mintA);
      const result = await verifyToken(token, bundleVerifySubkey);
      expect(result.valid).toBe(true);
    });
  });

  describe("NonceTracker roundtrip", () => {
    it("rejects replayed mint output", async () => {
      const tracker = new NonceTracker();
      const token = await mintToken(
        { agentId: "agent-1", sessionId: "session-1", scope: ["spine", "llm"] },
        bundleMintSubkey,
      );

      const first = await verifyToken(token, bundleVerifySubkey, { nonceTracker: tracker });
      expect(first.valid).toBe(true);

      const second = await verifyToken(token, bundleVerifySubkey, { nonceTracker: tracker });
      expect(second.valid).toBe(false);
      if (!second.valid) {
        expect(second.code).toBe("ERR_TOKEN_REPLAY");
      }
    });
  });
});
