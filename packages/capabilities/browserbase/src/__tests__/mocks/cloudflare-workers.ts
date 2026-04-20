// Minimal mock for cloudflare:workers to allow importing agent-runtime in vitest
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
