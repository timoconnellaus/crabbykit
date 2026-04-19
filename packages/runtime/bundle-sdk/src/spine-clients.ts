/**
 * Bundle-side adapter clients that RPC to SpineService.
 *
 * Each client reads the capability token from the bundle env and
 * proxies calls through the SPINE service binding. These are the
 * async counterparts of the DO's sync stores.
 */

import type {
  BundleHookBridge,
  BundleKvStoreClient,
  BundleSchedulerClient,
  BundleSessionChannel,
  BundleSessionStoreClient,
} from "./types.js";

interface SpineBinding {
  appendEntry(token: string, entry: unknown): Promise<unknown>;
  getEntries(token: string, options?: unknown): Promise<unknown[]>;
  getSession(token: string): Promise<unknown>;
  createSession(token: string, init?: unknown): Promise<unknown>;
  listSessions(token: string, filter?: unknown): Promise<unknown[]>;
  buildContext(token: string): Promise<unknown>;
  getCompactionCheckpoint(token: string): Promise<unknown>;
  kvGet(token: string, capabilityId: string, key: string): Promise<unknown>;
  kvPut(
    token: string,
    capabilityId: string,
    key: string,
    value: unknown,
    options?: unknown,
  ): Promise<void>;
  kvDelete(token: string, capabilityId: string, key: string): Promise<void>;
  kvList(token: string, capabilityId: string, prefix?: string): Promise<unknown[]>;
  scheduleCreate(token: string, schedule: unknown): Promise<unknown>;
  scheduleUpdate(token: string, scheduleId: string, patch: unknown): Promise<void>;
  scheduleDelete(token: string, scheduleId: string): Promise<void>;
  scheduleList(token: string): Promise<unknown[]>;
  alarmSet(token: string, timestamp: number): Promise<void>;
  broadcast(token: string, event: unknown): Promise<void>;
  broadcastGlobal(token: string, event: unknown): Promise<void>;
  emitCost(token: string, costEvent: unknown): Promise<void>;
  recordToolExecution(token: string, event: unknown): Promise<void>;
  processBeforeInference(token: string, messages: unknown[]): Promise<unknown[]>;
  processBeforeToolExecution(token: string, event: unknown): Promise<unknown>;
  recordPromptSections(
    token: string,
    sessionId: string,
    sections: unknown[],
    bundleVersionId: string,
  ): Promise<void>;
  getBundlePromptSections(
    token: string,
    sessionId: string,
    bundleVersionId?: string,
  ): Promise<unknown[]>;
}

/**
 * Create a bundle-side SessionStoreClient backed by SpineService RPC.
 */
export function createSessionStoreClient(
  spine: SpineBinding,
  getToken: () => string,
): BundleSessionStoreClient {
  return {
    appendEntry: (entry) => spine.appendEntry(getToken(), entry).then(() => {}),
    getEntries: (options) => spine.getEntries(getToken(), options),
    getSession: () => spine.getSession(getToken()),
    createSession: (init) => spine.createSession(getToken(), init),
    listSessions: (filter) => spine.listSessions(getToken(), filter),
    buildContext: () => spine.buildContext(getToken()),
    getCompactionCheckpoint: () => spine.getCompactionCheckpoint(getToken()),
  };
}

/**
 * Create a bundle-side KvStoreClient backed by SpineService RPC.
 */
export function createKvStoreClient(
  spine: SpineBinding,
  getToken: () => string,
): BundleKvStoreClient {
  return {
    get: (capabilityId, key) => spine.kvGet(getToken(), capabilityId, key),
    put: (capabilityId, key, value, options) =>
      spine.kvPut(getToken(), capabilityId, key, value, options),
    delete: (capabilityId, key) => spine.kvDelete(getToken(), capabilityId, key),
    list: (capabilityId, prefix) => spine.kvList(getToken(), capabilityId, prefix),
  };
}

/**
 * Create a bundle-side SchedulerClient backed by SpineService RPC.
 */
export function createSchedulerClient(
  spine: SpineBinding,
  getToken: () => string,
): BundleSchedulerClient {
  return {
    create: (schedule) => spine.scheduleCreate(getToken(), schedule),
    update: (scheduleId, patch) => spine.scheduleUpdate(getToken(), scheduleId, patch),
    delete: (scheduleId) => spine.scheduleDelete(getToken(), scheduleId),
    list: () => spine.scheduleList(getToken()),
    setAlarm: (timestamp) => spine.alarmSet(getToken(), timestamp),
  };
}

/**
 * Create a bundle-side send-only SessionChannel backed by SpineService RPC.
 */
export function createSessionChannel(
  spine: SpineBinding,
  getToken: () => string,
): BundleSessionChannel {
  return {
    broadcast: (event) => spine.broadcast(getToken(), event),
    broadcastGlobal: (event) => spine.broadcastGlobal(getToken(), event),
  };
}

/**
 * Create a bundle-side hook-bridge client backed by SpineService RPC.
 *
 * Bundle SDK runtime calls `recordToolExecution` after every tool
 * execution, `processBeforeInference` immediately before each model
 * inference call, and `processBeforeToolExecution` right before each
 * tool invocation — the host's existing `afterToolExecutionHooks`,
 * `beforeInferenceHooks`, and `beforeToolExecutionHooks` chains fire
 * against bundle-originated events, preserving functional parity between
 * static and bundle brains.
 * See `openspec/changes/bundle-shape-2-rollout/design.md` Decision 1.
 */
export function createHookBridge(spine: SpineBinding, getToken: () => string): BundleHookBridge {
  return {
    recordToolExecution: (event) => spine.recordToolExecution(getToken(), event),
    processBeforeInference: (messages) => spine.processBeforeInference(getToken(), messages),
    processBeforeToolExecution: (event) =>
      spine.processBeforeToolExecution(getToken(), event) as Promise<
        { block?: boolean; reason?: string } | undefined
      >,
  };
}

/**
 * Create a bundle-side inspection client backed by SpineService RPC.
 *
 * The bundle SDK calls `recordPromptSections(sessionId, sections,
 * bundleVersionId)` after each per-turn prompt build so the host can
 * cache the rendered `PromptSection[]` for the inspection panel.
 * `getBundlePromptSections(sessionId, bundleVersionId?)` returns the
 * cached entry; both wrap through the host's `"inspection"` budget
 * category.
 */
export function createBundleInspectionClient(
  spine: SpineBinding,
  getToken: () => string,
): {
  recordPromptSections(
    sessionId: string,
    sections: unknown[],
    bundleVersionId: string,
  ): Promise<void>;
  getBundlePromptSections(sessionId: string, bundleVersionId?: string): Promise<unknown[]>;
} {
  return {
    recordPromptSections: (sessionId, sections, bundleVersionId) =>
      spine.recordPromptSections(getToken(), sessionId, sections, bundleVersionId),
    getBundlePromptSections: (sessionId, bundleVersionId) =>
      spine.getBundlePromptSections(getToken(), sessionId, bundleVersionId),
  };
}

/**
 * Create a cost emitter backed by SpineService RPC.
 */
export function createCostEmitter(
  spine: SpineBinding,
  getToken: () => string,
): (cost: {
  capabilityId: string;
  toolName: string;
  amount: number;
  currency: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}) => Promise<void> {
  return (cost) => spine.emitCost(getToken(), cost);
}
