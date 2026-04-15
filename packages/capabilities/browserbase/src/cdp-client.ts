import type { CDPEvent, CDPResponse } from "./types.js";

/** Timeout for CDP commands in milliseconds. */
const DEFAULT_COMMAND_TIMEOUT_MS = 25_000;

/**
 * Lightweight Chrome DevTools Protocol client over WebSocket.
 * Workers-compatible — uses the standard WebSocket API, no Node.js deps.
 *
 * Browserbase's connect URL opens a browser-level CDP session. Page-level
 * domains (Page, DOM, Network, Accessibility) require attaching to a page
 * target first. After connect(), call `attachToPage()` to set up a flattened
 * session — all subsequent `send()` calls route through that session.
 */
export class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private connected = false;
  /** Flattened CDP session ID for page-level commands. */
  private sessionId: string | null = null;

  /** Connect to a CDP endpoint. */
  async connect(connectUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(connectUrl);

      ws.addEventListener("open", () => {
        this.ws = ws;
        this.connected = true;
        resolve();
      });

      ws.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : "";
        let msg: CDPResponse | CDPEvent;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }

        if ("id" in msg && typeof msg.id === "number") {
          const response = msg as CDPResponse;
          const entry = this.pending.get(response.id);
          if (entry) {
            this.pending.delete(response.id);
            if (response.error) {
              entry.reject(
                new Error(`CDP error: ${response.error.message} (${response.error.code})`),
              );
            } else {
              entry.resolve(response.result);
            }
          }
        } else if ("method" in msg) {
          const event = msg as CDPEvent;
          const handlers = this.listeners.get(event.method);
          if (handlers) {
            for (const handler of handlers) {
              handler(event.params ?? {});
            }
          }
        }
      });

      ws.addEventListener("error", () => {
        if (!this.connected) {
          reject(new Error("CDP WebSocket connection failed"));
        }
      });

      ws.addEventListener("close", () => {
        this.connected = false;
        this.ws = null;
        // Reject all pending commands
        for (const [id, entry] of this.pending) {
          entry.reject(new Error("CDP connection closed"));
          this.pending.delete(id);
        }
      });
    });
  }

  /**
   * Attach to a page target via Target.attachToTarget with flatten: true.
   * Finds the first `type: "page"` target, or creates one if none exist.
   * After this, all `send()` calls are routed through the page session.
   */
  async attachToPage(): Promise<void> {
    // Discover existing page targets
    const { targetInfos } = await this.sendRaw<{
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    }>("Target.getTargets");

    let pageTarget = targetInfos.find((t) => t.type === "page");

    if (!pageTarget) {
      // Create a new blank page
      const { targetId } = await this.sendRaw<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      pageTarget = { targetId, type: "page", url: "about:blank" };
    }

    // Attach with flatten so events/responses come on this connection
    const { sessionId } = await this.sendRaw<{ sessionId: string }>("Target.attachToTarget", {
      targetId: pageTarget.targetId,
      flatten: true,
    });

    this.sessionId = sessionId;
  }

  /** Send a CDP command and await the response. Routes through the page session if attached. */
  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.ws || !this.connected) {
      throw new Error("CDP client is not connected");
    }

    const id = ++this.nextId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      const msg: Record<string, unknown> = { id, method, params };
      if (this.sessionId) {
        msg.sessionId = this.sessionId;
      }
      this.ws!.send(JSON.stringify(msg));
    });
  }

  /**
   * Send a browser-level CDP command (bypasses the page session).
   * Used internally for Target domain operations.
   */
  private async sendRaw<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.ws || !this.connected) {
      throw new Error("CDP client is not connected");
    }

    const id = ++this.nextId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Register an event listener for a CDP event. */
  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    let handlers = this.listeners.get(method);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(method, handlers);
    }
    handlers.add(handler);
  }

  /** Remove an event listener. */
  off(method: string, handler: (params: Record<string, unknown>) => void): void {
    const handlers = this.listeners.get(method);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.listeners.delete(method);
      }
    }
  }

  /** Whether the client is currently connected. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Close the WebSocket connection. */
  close(): void {
    if (this.ws) {
      this.connected = false;
      this.ws.close();
      this.ws = null;
    }
  }
}
