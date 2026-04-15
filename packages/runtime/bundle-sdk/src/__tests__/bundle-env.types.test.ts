/**
 * Type-level tests for BundleEnv (task 2.10).
 *
 * Exercises the ValidateBundleEnv utility type with positive and negative
 * examples. Runtime assertions are trivial — the real checks are the
 * `@ts-expect-error` markers, which fail to compile if the type utility
 * stops rejecting forbidden bindings.
 */

import { describe, expectTypeOf, it } from "vitest";
import type { BundleEnv, ValidateBundleEnv } from "../types.js";

describe("BundleEnv type constraints", () => {
  it("allows Service<T> bindings", () => {
    interface E extends BundleEnv {
      LLM: Service<unknown>;
    }
    type Checked = ValidateBundleEnv<E>;
    expectTypeOf<Checked>().not.toBeNever();
    expectTypeOf<Checked>().toEqualTypeOf<E>();
  });

  it("allows serializable primitives (string, number, boolean)", () => {
    interface E extends BundleEnv {
      TIMEZONE: string;
      MAX_TOKENS: number;
      DEBUG: boolean;
    }
    type Checked = ValidateBundleEnv<E>;
    expectTypeOf<Checked>().not.toBeNever();
    expectTypeOf<Checked>().toEqualTypeOf<E>();
  });

  it("allows plain serializable objects", () => {
    interface E extends BundleEnv {
      CONFIG: { region: string; limit: number };
    }
    type Checked = ValidateBundleEnv<E>;
    expectTypeOf<Checked>().not.toBeNever();
  });

  it("rejects Ai (Workers AI binding)", () => {
    interface E extends BundleEnv {
      AI: Ai;
    }
    type Checked = ValidateBundleEnv<E>;
    expectTypeOf<Checked>().toBeNever();
  });

  it("rejects R2Bucket", () => {
    interface E extends BundleEnv {
      STORAGE: R2Bucket;
    }
    type Checked = ValidateBundleEnv<E>;
    expectTypeOf<Checked>().toBeNever();
  });

  it("rejects KVNamespace", () => {
    interface E extends BundleEnv {
      CACHE: KVNamespace;
    }
    type Checked = ValidateBundleEnv<E>;
    expectTypeOf<Checked>().toBeNever();
  });

  it("rejects D1Database", () => {
    interface E extends BundleEnv {
      DB: D1Database;
    }
    type Checked = ValidateBundleEnv<E>;
    expectTypeOf<Checked>().toBeNever();
  });

  it("rejects DurableObjectNamespace", () => {
    interface E extends BundleEnv {
      AGENT: DurableObjectNamespace;
    }
    type Checked = ValidateBundleEnv<E>;
    expectTypeOf<Checked>().toBeNever();
  });

  it("rejects any env that mixes allowed and forbidden bindings", () => {
    interface E extends BundleEnv {
      LLM: Service<unknown>;
      TIMEZONE: string;
      // One forbidden entry is enough to poison the whole env
      AI: Ai;
    }
    type Checked = ValidateBundleEnv<E>;
    expectTypeOf<Checked>().toBeNever();
  });

  it("placeholder runtime assertion — type checks run at compile time", () => {
    // Vitest requires at least one runtime expect per file; the type
    // checks above fire during `tsc --noEmit`, not at runtime.
    const sentinel: BundleEnv = { __SPINE_TOKEN: "x" };
    expectTypeOf(sentinel).toMatchTypeOf<BundleEnv>();
  });
});
