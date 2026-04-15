/**
 * Bundle-side adapter clients that RPC to SpineService.
 *
 * Each client reads the capability token from the bundle env and
 * proxies calls through the SPINE service binding. These are the
 * async counterparts of the DO's sync stores.
 */

import type {
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
