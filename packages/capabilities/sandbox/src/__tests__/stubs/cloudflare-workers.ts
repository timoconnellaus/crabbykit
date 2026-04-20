// Stub for cloudflare:workers used in unit tests.
// Provides DurableObject + WorkerEntrypoint — both are needed by
// transitive agent-runtime / bundle-host imports even when the test
// itself does not construct either.
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
