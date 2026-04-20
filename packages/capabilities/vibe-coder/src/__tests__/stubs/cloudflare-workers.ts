// Stub for cloudflare:workers used in unit tests.
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
