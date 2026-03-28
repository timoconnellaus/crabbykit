// Stub for cloudflare:workers used in unit tests.
// Only provides the DurableObject class needed by transitive agent-runtime imports.
export class DurableObject {
  constructor(
    public ctx: unknown,
    public env: unknown,
  ) {}
}
