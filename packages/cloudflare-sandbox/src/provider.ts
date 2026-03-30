import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type {
  ExecStreamEvent,
  ProcessInfo,
  SandboxExecResult,
  SandboxProvider,
} from "@claw-for-cloudflare/sandbox";

export interface CloudflareSandboxOptions {
  /**
   * Shared agent storage identity. The namespace is sent as x-agent-id header
   * to the container and used as the FUSE mount prefix for R2.
   */
  storage: AgentStorage;
  /**
   * Returns the Container Durable Object stub.
   * @example `() => env.SANDBOX.get(env.SANDBOX.idFromName(agentId))`
   */
  getStub: () => DurableObjectStub;
  /** Base URL for proxying requests to the container (default "http://container"). */
  baseUrl?: string;
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
    h["x-agent-id"] = this.options.storage.namespace();
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
    options?: { timeout?: number; cwd?: string; signal?: AbortSignal },
  ): Promise<SandboxExecResult> {
    const res = await this.fetch("/exec", {
      method: "POST",
      body: JSON.stringify({
        command,
        timeout: options?.timeout,
        cwd: options?.cwd,
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`exec failed: ${res.status} ${await res.text()}`);
    }

    return (await res.json()) as SandboxExecResult;
  }

  async *execStream(
    command: string,
    options?: { timeout?: number; cwd?: string; signal?: AbortSignal },
  ): AsyncGenerator<ExecStreamEvent> {
    const res = await this.fetch("/exec-stream", {
      method: "POST",
      body: JSON.stringify({
        command,
        timeout: options?.timeout,
        cwd: options?.cwd,
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      throw new Error(`exec-stream failed: ${res.status} ${await res.text()}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("exec-stream: no response body");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const parsed = JSON.parse(line.slice(6)) as {
            type: string;
            data?: string;
            code?: number;
          };
          if (parsed.type === "stdout" || parsed.type === "stderr") {
            yield { type: parsed.type, data: parsed.data ?? "" };
          } else if (parsed.type === "exit") {
            yield { type: "exit", code: parsed.code ?? 1 };
            return;
          }
          // Skip heartbeat
        }
      }
    } finally {
      reader.releaseLock();
    }
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

  async setDevPort(port: number): Promise<void> {
    const res = await this.fetch("/set-dev-port", {
      method: "POST",
      body: JSON.stringify({ port }),
    });
    if (!res.ok) {
      throw new Error(`set-dev-port failed: ${res.status} ${await res.text()}`);
    }
  }

  async clearDevPort(): Promise<void> {
    const res = await this.fetch("/clear-dev-port", { method: "POST" });
    if (!res.ok) {
      throw new Error(`clear-dev-port failed: ${res.status} ${await res.text()}`);
    }
  }
}
