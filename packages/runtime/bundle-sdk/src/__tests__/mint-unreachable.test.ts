/**
 * Security invariant: the bundle SDK MUST NOT expose mint-side token
 * primitives. Host-side callers reach mint through
 * `@claw-for-cloudflare/bundle-host/src/security/mint.ts`; the SDK is
 * a verify-only boundary because bundles run inside an isolated
 * Worker Loader sandbox that must never be able to forge tokens for
 * any service binding.
 *
 * This test documents the property as an assertion so that any future
 * refactor that accidentally re-exports `mintToken` or
 * `deriveMintSubkey` from the SDK barrel trips a red test — the failure
 * mode is subtle (a bundle could mint its own spine tokens and escape
 * per-turn budget enforcement), so a loud alarm is worth the pedantic
 * test.
 */

import { describe, expect, it } from "vitest";
import * as bundleSdk from "../index.js";

describe("bundle-sdk security boundary", () => {
  it("does not export mintToken from the authoring barrel", () => {
    expect((bundleSdk as Record<string, unknown>).mintToken).toBeUndefined();
  });

  it("does not export deriveMintSubkey from the authoring barrel", () => {
    expect((bundleSdk as Record<string, unknown>).deriveMintSubkey).toBeUndefined();
  });

  it("does not export the legacy deriveSubkey helper", () => {
    // The pre-split `deriveSubkey` helper returned a CryptoKey with
    // `usages: ["sign", "verify"]` — functionally equivalent to having
    // a mint subkey in hand. Asserting it is gone protects against a
    // regression that copies the helper back into bundle-sdk for
    // convenience.
    expect((bundleSdk as Record<string, unknown>).deriveSubkey).toBeUndefined();
  });

  it("any exported symbol that looks crypto-related is verify-only", () => {
    // A defensive-in-depth check: walk every exported name and flag
    // anything that contains `mint` or `sign` case-insensitively. If
    // this list ever grows, the SDK has drifted and the split's
    // security property is weakening.
    const suspicious = Object.keys(bundleSdk).filter((k) => /mint|sign/i.test(k));
    expect(suspicious).toEqual([]);
  });
});
