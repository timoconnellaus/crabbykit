import type { ProcessInfo, SandboxExecResult, SandboxProvider } from "@claw-for-cloudflare/sandbox";

export interface CloudflareSandboxOptions {
  /**
   * Returns the Container Durable Object stub.
   * @example `() => env.SANDBOX.get(env.SANDBOX.idFromName(agentId))`
   */
  getStub: () => DurableObjectStub;
  /** Base URL for proxying requests to the container (default "http://container"). */
  baseUrl?: string;
  /** Agent ID sent via x-agent-id header to the container. */
  agentId?: string;
  /** Container mode: "normal" or "dev". Dev mode enables restic persist sync. */
  containerMode?: "normal" | "dev";
}

/**
 * SandboxProvider backed by Cloudflare Containers.
 *
 * Proxies all sandbox operations to a Container Durable Object via HTTP.
 * The container image must run an HTTP server with matching endpoints
 * (see container/ directory for reference scripts).
 */
export class CloudflareSandboxProvider implements SandboxProvider {
  private options: CloudflareSandboxOptions;
  private baseUrl: string;

  constructor(options: CloudflareSandboxOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl ?? "http://container";
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.options.agentId) {
      h["x-agent-id"] = this.options.agentId;
    }
    if (this.options.containerMode) {
      h["x-container-mode"] = this.options.containerMode;
    }
    return h;
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const stub = this.options.getStub();
    return stub.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers, ...(init?.headers as Record<string, string>) },
    });
  }

  async start(options?: { envVars?: Record<string, string> }): Promise<void> {
    // Calling /health on a CF Container starts it if not running
    const healthRes = await this.fetch("/health");
    if (!healthRes.ok) {
      throw new Error(`Container health check failed: ${healthRes.status}`);
    }

    // If env vars provided, initialize the container
    if (options?.envVars && Object.keys(options.envVars).length > 0) {
      const initRes = await this.fetch("/init", {
        method: "POST",
        body: JSON.stringify({ envVars: options.envVars }),
      });
      if (!initRes.ok) {
        throw new Error(`Container init failed: ${initRes.status}`);
      }
    }
  }

  async stop(): Promise<void> {
    const res = await this.fetch("/stop", { method: "POST" });
    if (!res.ok) {
      throw new Error(`Container stop failed: ${res.status}`);
    }
  }

  async health(): Promise<{ ready: boolean; [key: string]: unknown }> {
    const res = await this.fetch("/health");
    if (!res.ok) {
      return { ready: false, status: res.status };
    }
    return (await res.json()) as { ready: boolean; [key: string]: unknown };
  }

  async exec(
    command: string,
    options?: { timeout?: number; cwd?: string },
  ): Promise<SandboxExecResult> {
    const res = await this.fetch("/exec", {
      method: "POST",
      body: JSON.stringify({
        command,
        timeout: options?.timeout,
        cwd: options?.cwd,
      }),
    });

    if (!res.ok) {
      throw new Error(`exec failed: ${res.status} ${await res.text()}`);
    }

    return (await res.json()) as SandboxExecResult;
  }

  async processStart(name: string, command: string, cwd?: string): Promise<{ pid?: number }> {
    const res = await this.fetch("/process-start", {
      method: "POST",
      body: JSON.stringify({ name, command, cwd }),
    });

    if (!res.ok) {
      throw new Error(`process-start failed: ${res.status} ${await res.text()}`);
    }

    return (await res.json()) as { pid?: number };
  }

  async processStop(name: string): Promise<void> {
    const res = await this.fetch("/process-stop", {
      method: "POST",
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      throw new Error(`process-stop failed: ${res.status} ${await res.text()}`);
    }
  }

  async processList(): Promise<ProcessInfo[]> {
    const res = await this.fetch("/process-list");

    if (!res.ok) {
      throw new Error(`process-list failed: ${res.status} ${await res.text()}`);
    }

    return (await res.json()) as ProcessInfo[];
  }

  async triggerSync(): Promise<void> {
    const res = await this.fetch("/trigger-sync", { method: "POST" });
    if (!res.ok) {
      throw new Error(`trigger-sync failed: ${res.status} ${await res.text()}`);
    }
  }
}
