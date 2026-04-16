export class WorkerEntrypoint<TEnv = unknown> {
  readonly ctx: unknown;
  readonly env: TEnv;
  constructor(ctx: unknown, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject<TEnv = unknown> {
  readonly ctx: unknown;
  readonly env: TEnv;
  constructor(ctx: unknown, env: TEnv) {
    this.ctx = ctx;
    this.env = env;
  }
}
