/**
 * Unified token scope isolation matrix (Gap 7).
 *
 * Verifies that `verifyToken` + `requiredScope` correctly partitions access
 * between the three canonical service scopes: "spine", "llm", and a sample
 * capability scope ("tavily-web-search"). Each row in the matrix is a token
 * minted with a specific scope array, checked against each requiredScope
 * value.
 *
 * Also covers the wrong-subkey rejection path (ERR_BAD_TOKEN) to confirm
 * that subkey domain separation is enforced at the crypto layer.
 *
 * Tests run in the standard vitest environment (Node Web Crypto) — no
 * pool-workers needed since we exercise verifyToken directly.
 */

import { BUNDLE_SUBKEY_LABEL, deriveVerifyOnlySubkey, verifyToken } from "@claw-for-cloudflare/bundle-token";
import { describe, expect, it } from "vitest";
import { deriveMintSubkey, mintToken } from "../security/mint.js";

const MASTER_KEY = "test-master-key-for-scope-matrix-00000";
const ALT_MASTER_KEY = "different-master-key-0000000000000000";

/**
 * Derive mint subkey (sign-capable) and verify-only subkey from the same
 * master. Both sides use BUNDLE_SUBKEY_LABEL — the verify-only subkey is
 * what services hold; the mint subkey is what the dispatcher holds.
 */
async function makeKeys(): Promise<{ mintKey: CryptoKey; verifyKey: CryptoKey }> {
  const [mintKey, verifyKey] = await Promise.all([
    deriveMintSubkey(MASTER_KEY, BUNDLE_SUBKEY_LABEL),
    deriveVerifyOnlySubkey(MASTER_KEY, BUNDLE_SUBKEY_LABEL),
  ]);
  return { mintKey, verifyKey };
}

/** Mint a token with the given scope array. */
async function mint(scope: string[], mintKey: CryptoKey): Promise<string> {
  return mintToken({ agentId: "agent-scope-test", sessionId: "s1", scope }, mintKey);
}

describe("unified token scope isolation matrix", () => {
  // --- scope-only-spine ---

  it("scope=['spine']: accepted by spine service (requiredScope='spine')", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint(["spine"], mintKey);
    const result = await verifyToken(token, verifyKey, { requiredScope: "spine" });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.scope).toEqual(["spine"]);
    }
  });

  it("scope=['spine']: denied by llm service (requiredScope='llm')", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint(["spine"], mintKey);
    const result = await verifyToken(token, verifyKey, { requiredScope: "llm" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("ERR_SCOPE_DENIED");
    }
  });

  it("scope=['spine']: denied by tavily service (requiredScope='tavily-web-search')", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint(["spine"], mintKey);
    const result = await verifyToken(token, verifyKey, { requiredScope: "tavily-web-search" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("ERR_SCOPE_DENIED");
    }
  });

  // --- scope-only-llm ---

  it("scope=['llm']: denied by spine service (requiredScope='spine')", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint(["llm"], mintKey);
    const result = await verifyToken(token, verifyKey, { requiredScope: "spine" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("ERR_SCOPE_DENIED");
    }
  });

  it("scope=['llm']: accepted by llm service (requiredScope='llm')", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint(["llm"], mintKey);
    const result = await verifyToken(token, verifyKey, { requiredScope: "llm" });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.scope).toEqual(["llm"]);
    }
  });

  it("scope=['llm']: denied by tavily service (requiredScope='tavily-web-search')", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint(["llm"], mintKey);
    const result = await verifyToken(token, verifyKey, { requiredScope: "tavily-web-search" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("ERR_SCOPE_DENIED");
    }
  });

  // --- scope-only-tavily ---

  it("scope=['tavily-web-search']: denied by spine service (requiredScope='spine')", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint(["tavily-web-search"], mintKey);
    const result = await verifyToken(token, verifyKey, { requiredScope: "spine" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("ERR_SCOPE_DENIED");
    }
  });

  it("scope=['tavily-web-search']: denied by llm service (requiredScope='llm')", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint(["tavily-web-search"], mintKey);
    const result = await verifyToken(token, verifyKey, { requiredScope: "llm" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("ERR_SCOPE_DENIED");
    }
  });

  it("scope=['tavily-web-search']: accepted by tavily service (requiredScope='tavily-web-search')", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint(["tavily-web-search"], mintKey);
    const result = await verifyToken(token, verifyKey, { requiredScope: "tavily-web-search" });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.scope).toEqual(["tavily-web-search"]);
    }
  });

  // --- scope with all three ---

  it("scope=['spine','llm','tavily-web-search']: accepted by all three services", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint(["spine", "llm", "tavily-web-search"], mintKey);

    const [spineResult, llmResult, tavilyResult] = await Promise.all([
      verifyToken(token, verifyKey, { requiredScope: "spine" }),
      verifyToken(token, verifyKey, { requiredScope: "llm" }),
      verifyToken(token, verifyKey, { requiredScope: "tavily-web-search" }),
    ]);

    expect(spineResult.valid).toBe(true);
    expect(llmResult.valid).toBe(true);
    expect(tavilyResult.valid).toBe(true);
  });

  // --- empty scope ---

  it("scope=[]: denied by all three services", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint([], mintKey);

    const [spineResult, llmResult, tavilyResult] = await Promise.all([
      verifyToken(token, verifyKey, { requiredScope: "spine" }),
      verifyToken(token, verifyKey, { requiredScope: "llm" }),
      verifyToken(token, verifyKey, { requiredScope: "tavily-web-search" }),
    ]);

    expect(spineResult.valid).toBe(false);
    if (!spineResult.valid) expect(spineResult.code).toBe("ERR_SCOPE_DENIED");

    expect(llmResult.valid).toBe(false);
    if (!llmResult.valid) expect(llmResult.code).toBe("ERR_SCOPE_DENIED");

    expect(tavilyResult.valid).toBe(false);
    if (!tavilyResult.valid) expect(tavilyResult.code).toBe("ERR_SCOPE_DENIED");
  });

  it("scope=[]: accepted when no requiredScope is specified (signature-only check)", async () => {
    const { mintKey, verifyKey } = await makeKeys();
    const token = await mint([], mintKey);
    // Without requiredScope, only signature + expiry are checked
    const result = await verifyToken(token, verifyKey);
    expect(result.valid).toBe(true);
  });

  // --- wrong subkey (cross-master-key attack) ---

  it("token minted with wrong subkey produces ERR_BAD_TOKEN regardless of scope", async () => {
    // Attacker derives a mint key from a different master — signature won't
    // match the verifier's subkey derived from the real master.
    const [attackerMintKey, realVerifyKey] = await Promise.all([
      deriveMintSubkey(ALT_MASTER_KEY, BUNDLE_SUBKEY_LABEL),
      deriveVerifyOnlySubkey(MASTER_KEY, BUNDLE_SUBKEY_LABEL),
    ]);

    // Attacker mints a token that includes all scopes
    const forgeryToken = await mint(["spine", "llm", "tavily-web-search"], attackerMintKey);

    const result = await verifyToken(forgeryToken, realVerifyKey, { requiredScope: "spine" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("ERR_BAD_TOKEN");
    }
  });

  it("wrong subkey is rejected before scope check (ERR_BAD_TOKEN, not ERR_SCOPE_DENIED)", async () => {
    // Confirms the verification order: signature check (step 2) precedes
    // scope check (step 6). A forged token never reaches scope evaluation.
    const [attackerMintKey, realVerifyKey] = await Promise.all([
      deriveMintSubkey(ALT_MASTER_KEY, BUNDLE_SUBKEY_LABEL),
      deriveVerifyOnlySubkey(MASTER_KEY, BUNDLE_SUBKEY_LABEL),
    ]);

    // Even a token with the wrong scope would get ERR_SCOPE_DENIED on a
    // real key — but with a forged signature the code must be ERR_BAD_TOKEN.
    const forgeryToken = await mint(["only-wrong-scope"], attackerMintKey);
    const result = await verifyToken(forgeryToken, realVerifyKey, { requiredScope: "spine" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // Must be ERR_BAD_TOKEN (sig fails at step 2), not ERR_SCOPE_DENIED (step 6)
      expect(result.code).toBe("ERR_BAD_TOKEN");
    }
  });
});
