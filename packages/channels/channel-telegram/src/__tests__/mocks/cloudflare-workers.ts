// Minimal mock for `cloudflare:workers` so that importing
// `@crabbykit/agent-runtime` (which indirectly imports from
// `agent-do.ts`) succeeds under the node test environment. The
// channel-telegram unit tests exercise pure logic (parsing, verification,
// chunking, `defineChannel` wiring) and never touch DurableObject at
// runtime, so a no-op class is sufficient.
export class DurableObject {
  constructor(
    public ctx: unknown,
    public env: unknown,
  ) {}
}
export class WorkerEntrypoint {
  constructor(
    public ctx: unknown,
    public env: unknown,
  ) {}
}
