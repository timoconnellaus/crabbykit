/**
 * D1 batch atomicity unit tests (task 5.13).
 *
 * D1BundleRegistry wraps multi-statement updates (setActive, rollback) in
 * a single `db.batch([...])` call so failures are atomic. These tests
 * verify:
 *  - setActive issues a single batch with the expected number of statements
 *  - rollback issues a single batch
 *  - a batch failure propagates to the caller (no silent swallow)
 *  - after a batch failure, no D1 state is observable (batch never ran)
 *
 * D1 is faked as an in-memory statement recorder. We do not execute SQL —
 * the goal is to verify the call shape and error propagation, not the
 * SQL itself (which is exercised in pool-workers integration tests).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { D1BundleRegistry } from "../d1-registry.js";

interface RecordedStatement {
  sql: string;
  binds: unknown[];
}

interface FakeD1Options {
  failBatchOnCall?: number; // 1 = fail first batch, 2 = second, etc.
  existingAgentBundle?: {
    active_version_id: string | null;
    previous_version_id: string | null;
  } | null;
}

function makeFakeD1(options: FakeD1Options = {}) {
  const batchCalls: RecordedStatement[][] = [];
  const runCalls: RecordedStatement[] = [];
  const firstCalls: RecordedStatement[] = [];
  let batchCount = 0;

  const makeStatement = (sql: string): D1PreparedStatement => {
    const binds: unknown[] = [];
    const stmt: Partial<D1PreparedStatement> & {
      __sql: string;
      __binds: unknown[];
    } = {
      __sql: sql,
      __binds: binds,
      bind(...args: unknown[]) {
        binds.push(...args);
        return stmt as D1PreparedStatement;
      },
      async first<T = unknown>() {
        firstCalls.push({ sql, binds: [...binds] });
        // Return whatever the test pre-stashed
        if (/FROM agent_bundles/.test(sql) && options.existingAgentBundle) {
          return options.existingAgentBundle as T;
        }
        if (/FROM bundle_versions/.test(sql)) {
          return null as T;
        }
        return null as T;
      },
      async run() {
        runCalls.push({ sql, binds: [...binds] });
        return { success: true } as D1Result;
      },
      async all<T = unknown>() {
        return { results: [] as T[], success: true } as D1Result<T>;
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };

  const db: Partial<D1Database> = {
    prepare(sql: string) {
      return makeStatement(sql);
    },
    async batch(statements: D1PreparedStatement[]) {
      batchCount += 1;
      if (options.failBatchOnCall === batchCount) {
        throw new Error("D1_BATCH_PARTIAL_FAILURE");
      }
      const recorded = statements.map((s) => {
        const withMeta = s as unknown as {
          __sql: string;
          __binds: unknown[];
        };
        return { sql: withMeta.__sql, binds: withMeta.__binds };
      });
      batchCalls.push(recorded);
      return statements.map(() => ({ success: true })) as D1Result[];
    },
  };

  return {
    db: db as D1Database,
    batchCalls,
    runCalls,
    firstCalls,
    getBatchCount: () => batchCount,
  };
}

function makeFakeKv(): KVNamespace & { puts: Array<[string, unknown]> } {
  const store = new Map<string, ArrayBuffer>();
  const puts: Array<[string, unknown]> = [];
  const kv: Partial<KVNamespace> = {
    async put(key: string, value: ArrayBuffer | Uint8Array | string) {
      puts.push([key, value]);
      if (typeof value === "string") {
        store.set(key, new TextEncoder().encode(value).buffer as ArrayBuffer);
      } else if (value instanceof ArrayBuffer) {
        store.set(key, value);
      } else {
        store.set(key, value.buffer.slice(0) as ArrayBuffer);
      }
    },
    async get(key: string, _type?: unknown) {
      return (store.get(key) ?? null) as never;
    },
  };
  (kv as unknown as { puts: typeof puts }).puts = puts;
  return kv as KVNamespace & { puts: typeof puts };
}

const FAST_BYTES = new Uint8Array([1, 2, 3, 4]).buffer;

describe("D1BundleRegistry batch atomicity", () => {
  let fake: ReturnType<typeof makeFakeD1>;
  let kv: ReturnType<typeof makeFakeKv>;
  let registry: D1BundleRegistry;

  beforeEach(() => {
    fake = makeFakeD1();
    kv = makeFakeKv();
    registry = new D1BundleRegistry(fake.db, kv);
  });

  it("setActive uses a single batch with both the pointer update and the deployment log insert", async () => {
    await registry.setActive("agent-1", "ver-abc", {
      sessionId: "s1",
      rationale: "initial",
      skipCatalogCheck: true,
    });

    // 1 batch for ensureTable (schema) + 1 batch for setActive = 2 batches
    expect(fake.getBatchCount()).toBe(2);
    const setActiveBatch = fake.batchCalls[1];
    expect(setActiveBatch).toHaveLength(2);
    expect(setActiveBatch[0].sql).toMatch(/INTO agent_bundles/);
    expect(setActiveBatch[1].sql).toMatch(/INTO bundle_deployments/);
    // Binds include the agent id and version id
    expect(setActiveBatch[0].binds.slice(0, 2)).toEqual(["agent-1", "ver-abc"]);
  });

  it("rollback uses a single batch with swap + deployment log", async () => {
    fake = makeFakeD1({
      existingAgentBundle: {
        active_version_id: "ver-new",
        previous_version_id: "ver-old",
      },
    });
    registry = new D1BundleRegistry(fake.db, makeFakeKv());

    await registry.rollback("agent-1", { rationale: "bad deploy" });

    // 1 batch for ensureTable + 1 for rollback
    expect(fake.getBatchCount()).toBe(2);
    const rollbackBatch = fake.batchCalls[1];
    expect(rollbackBatch).toHaveLength(2);
    expect(rollbackBatch[0].sql).toMatch(/UPDATE agent_bundles/);
    expect(rollbackBatch[1].sql).toMatch(/INTO bundle_deployments/);
  });

  it("propagates a batch failure from setActive without swallowing", async () => {
    // Fail the second batch (first = ensureTable schema, second = setActive)
    fake = makeFakeD1({ failBatchOnCall: 2 });
    registry = new D1BundleRegistry(fake.db, makeFakeKv());

    await expect(
      registry.setActive("agent-1", "ver-abc", { skipCatalogCheck: true }),
    ).rejects.toThrow("D1_BATCH_PARTIAL_FAILURE");

    // batchCalls only records successful batches — the schema batch
    // succeeded but the setActive batch threw, so only one recorded.
    expect(fake.batchCalls.length).toBe(1);
    expect(fake.batchCalls[0][0].sql).toMatch(/CREATE TABLE IF NOT EXISTS bundle_versions/);
  });

  it("propagates a batch failure from rollback", async () => {
    fake = makeFakeD1({
      failBatchOnCall: 2,
      existingAgentBundle: {
        active_version_id: "v2",
        previous_version_id: "v1",
      },
    });
    registry = new D1BundleRegistry(fake.db, makeFakeKv());

    await expect(registry.rollback("agent-1")).rejects.toThrow("D1_BATCH_PARTIAL_FAILURE");
  });

  it("rollback throws a clear error when no previous version exists (before any batch runs)", async () => {
    fake = makeFakeD1({
      existingAgentBundle: { active_version_id: "v1", previous_version_id: null },
    });
    registry = new D1BundleRegistry(fake.db, makeFakeKv());

    await expect(registry.rollback("agent-1")).rejects.toThrow(
      "No previous version to roll back to",
    );

    // Only the ensureTable batch ran; no rollback batch was attempted.
    expect(fake.getBatchCount()).toBe(1);
  });

  it("createVersion wraps the schema in a batch and the version insert in a run (atomic single-row write)", async () => {
    // Stub readback so the test finishes quickly
    const readback = vi.spyOn(await import("../readback.js"), "verifyKvReadback");
    readback.mockResolvedValue(undefined);

    await registry.createVersion({ bytes: FAST_BYTES });

    // At least the schema batch ran once
    expect(fake.getBatchCount()).toBeGreaterThanOrEqual(1);
    // And the version row was inserted via a single run() (atomic)
    expect(fake.runCalls.some((c) => /INTO bundle_versions/.test(c.sql))).toBe(true);
    // KV received the bytes
    expect(kv.puts.length).toBe(1);
    readback.mockRestore();
  });
});
