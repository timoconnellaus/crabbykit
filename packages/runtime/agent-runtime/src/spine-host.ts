/**
 * `SpineHost` — the contract the host DO implements to receive bridged
 * calls from `SpineService`.
 *
 * Lives in `agent-runtime` rather than `bundle-host` because the DO
 * (`AgentDO` in this package) is the structural implementation of the
 * interface. Keeping the contract next to the implementation means a
 * drift-free type-level assertion can live in `agent-do.ts`:
 *
 *   const _spineHostCheck: (x: AgentDO<any>) => SpineHost = (x) => x;
 *
 * `bundle-host/src/services/spine-service.ts` imports this interface
 * to constrain the shape of its RPC callbacks without creating a
 * direct runtime edge from `bundle-host` into `agent-runtime` for
 * values — only a type-level one.
 */

export interface SpineHost {
  // Session store (sync on DO side)
  spineAppendEntry(sessionId: string, entry: unknown): unknown;
  spineGetEntries(sessionId: string, options?: unknown): unknown[];
  spineGetSession(sessionId: string): unknown;
  spineCreateSession(init?: unknown): unknown;
  spineListSessions(filter?: unknown): unknown[];
  spineBuildContext(sessionId: string): unknown;
  spineGetCompactionCheckpoint(sessionId: string): unknown;

  // KV store (async on DO side)
  spineKvGet(capabilityId: string, key: string): Promise<unknown>;
  spineKvPut(capabilityId: string, key: string, value: unknown, options?: unknown): Promise<void>;
  spineKvDelete(capabilityId: string, key: string): Promise<void>;
  spineKvList(capabilityId: string, prefix?: string): Promise<unknown[]>;

  // Scheduler
  spineScheduleCreate(schedule: unknown): Promise<unknown>;
  spineScheduleUpdate(scheduleId: string, patch: unknown): Promise<void>;
  spineScheduleDelete(scheduleId: string): Promise<void>;
  spineScheduleList(): Promise<unknown[]>;
  spineAlarmSet(timestamp: number): Promise<void>;

  // Transport (sync broadcast on DO side)
  spineBroadcast(sessionId: string, event: unknown): void;
  spineBroadcastGlobal(event: unknown): void;

  // Cost emission
  spineEmitCost(sessionId: string, costEvent: unknown): void;
}
