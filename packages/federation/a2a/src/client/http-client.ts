import type {
  JsonRpcRequest,
  JsonRpcResponse,
  MessageSendParams,
  StreamEvent,
  Task,
} from "../types.js";
import { isJsonRpcError } from "../types.js";
import { A2A_PROTOCOL_VERSION } from "../version.js";

// ============================================================================
// A2A Error
// ============================================================================

export class A2AClientError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "A2AClientError";
  }
}

// ============================================================================
// A2A HTTP Client
// ============================================================================

/**
 * Low-level HTTP client for calling A2A servers.
 * Builds JSON-RPC requests, sends via fetch(), parses responses.
 */
export class A2AHttpClient {
  constructor(
    private agentUrl: string,
    private fetchFn: typeof fetch,
    private authHeaders?: () => Record<string, string> | Promise<Record<string, string>>,
  ) {}

  // --- Message Operations ---

  async sendMessage(params: MessageSendParams): Promise<Task> {
    const result = await this.call<Task | { task: Task }>("message/send", params);
    // Response can be a Task directly or wrapped in { task: Task }
    if ("task" in result && result.task) return result.task as Task;
    return result as Task;
  }

  async *sendMessageStream(params: MessageSendParams): AsyncGenerator<StreamEvent> {
    const rpcRequest = this.buildRequest("message/stream", params);
    const response = await this.doFetch(rpcRequest, {
      Accept: "text/event-stream",
    });

    if (!response.ok) {
      const body = await response.text();
      throw new A2AClientError(response.status, `HTTP ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new A2AClientError(-1, "No response body for streaming request");
    }

    yield* this.parseSSEStream(response);
  }

  // --- Task Operations ---

  async getTask(taskId: string, historyLength?: number): Promise<Task> {
    return this.call<Task>("tasks/get", {
      id: taskId,
      ...(historyLength !== undefined ? { historyLength } : {}),
    });
  }

  async cancelTask(taskId: string): Promise<Task> {
    return this.call<Task>("tasks/cancel", { id: taskId });
  }

  async listTasks(contextId?: string): Promise<Task[]> {
    return this.call<Task[]>("tasks/list", {
      ...(contextId ? { contextId } : {}),
    });
  }

  // --- Internal ---

  private buildRequest(method: string, params: unknown): JsonRpcRequest {
    return {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: params as JsonRpcRequest["params"],
    };
  }

  private async doFetch(
    rpcRequest: JsonRpcRequest,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "A2A-Version": A2A_PROTOCOL_VERSION,
      ...extraHeaders,
    };

    if (this.authHeaders) {
      const auth = await this.authHeaders();
      Object.assign(headers, auth);
    }

    const endpoint = this.agentUrl.endsWith("/a2a") ? this.agentUrl : `${this.agentUrl}/a2a`;

    return this.fetchFn(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(rpcRequest),
    });
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const rpcRequest = this.buildRequest(method, params);
    const response = await this.doFetch(rpcRequest);

    if (!response.ok && response.status !== 200) {
      const body = await response.text();
      throw new A2AClientError(response.status, `HTTP ${response.status}: ${body}`);
    }

    const rpcResponse = (await response.json()) as JsonRpcResponse;
    if (isJsonRpcError(rpcResponse)) {
      throw new A2AClientError(
        rpcResponse.error.code,
        rpcResponse.error.message,
        rpcResponse.error.data,
      );
    }

    return rpcResponse.result as T;
  }

  private async *parseSSEStream(response: Response): AsyncGenerator<StreamEvent> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on double newline (SSE event boundary)
        const events = buffer.split("\n\n");
        buffer = events.pop()!; // Keep incomplete last chunk

        for (const event of events) {
          if (!event.trim()) continue;

          const dataLine = event.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;

          const json = JSON.parse(dataLine.slice(6)) as JsonRpcResponse;
          if (isJsonRpcError(json)) {
            throw new A2AClientError(json.error.code, json.error.message, json.error.data);
          }

          yield json.result as StreamEvent;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
