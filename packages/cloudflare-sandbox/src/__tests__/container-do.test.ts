import { describe, expect, it, vi } from "vitest";
import { SandboxContainer } from "../container-do.js";

/**
 * SandboxContainer extends Container (from @cloudflare/containers) which
 * requires a real Cloudflare runtime. We test the constructor logic and
 * fetch override by mocking the Container base class.
 */

// Mock the Container base class
vi.mock("@cloudflare/containers", () => {
  class MockContainer {
    defaultPort?: number;
    sleepAfter?: string;
    enableInternet?: boolean;
    envVars?: Record<string, string>;

    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}

    async fetch(_request: Request): Promise<Response> {
      return new Response("ok");
    }
  }
  return { Container: MockContainer };
});

function createCtx(name?: string) {
  return {
    id: { name, toString: () => name ?? "hex-id" },
  } as ConstructorParameters<typeof SandboxContainer>[0];
}

function createEnv(overrides?: Partial<Record<string, unknown>>) {
  return {
    AWS_ACCESS_KEY_ID: "AKID",
    AWS_SECRET_ACCESS_KEY: "secret",
    R2_ACCOUNT_ID: "acct-123",
    R2_BUCKET_NAME: "my-bucket",
    DB_SERVICE: {
      exec: vi.fn(),
      batch: vi.fn(),
    },
    OPENROUTER_API_KEY: "test-openrouter-key",
    ...overrides,
  };
}

describe("SandboxContainer", () => {
  describe("constructor", () => {
    it("sets default configuration properties", () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());

      expect(container.defaultPort).toBe(8080);
      expect(container.sleepAfter).toBe("2h");
      expect(container.enableInternet).toBe(true);
    });

    it("passes R2 credentials and agent ID to envVars", () => {
      const env = createEnv();
      const container = new SandboxContainer(createCtx("my-agent"), env);

      expect(container.envVars).toEqual({
        AWS_ACCESS_KEY_ID: "AKID",
        AWS_SECRET_ACCESS_KEY: "secret",
        R2_ACCOUNT_ID: "acct-123",
        R2_BUCKET_NAME: "my-bucket",
        AGENT_ID: "my-agent",
      });
    });

    it("uses 'default' when ctx.id.name is undefined", () => {
      const container = new SandboxContainer(createCtx(undefined), createEnv());

      expect(container.envVars?.AGENT_ID).toBe("default");
    });

    it("uses 'default' when ctx.id.name is null-ish", () => {
      const ctx = { id: { name: null } } as unknown as ConstructorParameters<typeof SandboxContainer>[0];
      const container = new SandboxContainer(ctx, createEnv());

      expect(container.envVars?.AGENT_ID).toBe("default");
    });
  });

  describe("fetch", () => {
    it("delegates to super.fetch for normal requests", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());
      const request = new Request("http://container/exec", { method: "POST" });

      const response = await container.fetch(request);

      expect(response).toBeInstanceOf(Response);
      expect(await response.text()).toBe("ok");
    });

    it("picks up x-agent-id header when AGENT_ID is default", async () => {
      const container = new SandboxContainer(createCtx(undefined), createEnv());
      expect(container.envVars?.AGENT_ID).toBe("default");

      const request = new Request("http://container/exec", {
        headers: { "x-agent-id": "injected-agent" },
      });

      await container.fetch(request);

      expect(container.envVars?.AGENT_ID).toBe("injected-agent");
    });

    it("does not override AGENT_ID when already set to a non-default value", async () => {
      const container = new SandboxContainer(createCtx("specific-agent"), createEnv());

      const request = new Request("http://container/exec", {
        headers: { "x-agent-id": "different-agent" },
      });

      await container.fetch(request);

      expect(container.envVars?.AGENT_ID).toBe("specific-agent");
    });

    it("picks up x-container-mode header", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());

      const request = new Request("http://container/health", {
        headers: { "x-container-mode": "dev" },
      });

      await container.fetch(request);

      expect(container.envVars?.CONTAINER_MODE).toBe("dev");
    });

    it("overwrites CONTAINER_MODE on subsequent requests", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());

      await container.fetch(
        new Request("http://container/health", {
          headers: { "x-container-mode": "dev" },
        }),
      );
      expect(container.envVars?.CONTAINER_MODE).toBe("dev");

      await container.fetch(
        new Request("http://container/health", {
          headers: { "x-container-mode": "normal" },
        }),
      );
      expect(container.envVars?.CONTAINER_MODE).toBe("normal");
    });

    it("does not set CONTAINER_MODE when header is absent", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());

      await container.fetch(new Request("http://container/health"));

      expect(container.envVars?.CONTAINER_MODE).toBeUndefined();
    });

    it("handles both x-agent-id and x-container-mode simultaneously", async () => {
      const container = new SandboxContainer(createCtx(undefined), createEnv());

      const request = new Request("http://container/exec", {
        headers: {
          "x-agent-id": "new-agent",
          "x-container-mode": "dev",
        },
      });

      await container.fetch(request);

      expect(container.envVars?.AGENT_ID).toBe("new-agent");
      expect(container.envVars?.CONTAINER_MODE).toBe("dev");
    });

    it("preserves R2 credentials when updating AGENT_ID via header", async () => {
      const container = new SandboxContainer(createCtx(undefined), createEnv());

      await container.fetch(
        new Request("http://container/exec", {
          headers: { "x-agent-id": "override-agent" },
        }),
      );

      expect(container.envVars).toMatchObject({
        AWS_ACCESS_KEY_ID: "AKID",
        AWS_SECRET_ACCESS_KEY: "secret",
        R2_ACCOUNT_ID: "acct-123",
        R2_BUCKET_NAME: "my-bucket",
        AGENT_ID: "override-agent",
      });
    });

    it("preserves R2 credentials when updating CONTAINER_MODE via header", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());

      await container.fetch(
        new Request("http://container/exec", {
          headers: { "x-container-mode": "dev" },
        }),
      );

      expect(container.envVars).toMatchObject({
        AWS_ACCESS_KEY_ID: "AKID",
        AWS_SECRET_ACCESS_KEY: "secret",
        R2_ACCOUNT_ID: "acct-123",
        R2_BUCKET_NAME: "my-bucket",
        AGENT_ID: "agent-1",
        CONTAINER_MODE: "dev",
      });
    });
  });

  describe("static outboundByHost", () => {
    it("maps db.internal to handleDbRequest", () => {
      expect(SandboxContainer.outboundByHost["db.internal"]).toBe("handleDbRequest");
    });

    it("maps ai.internal to handleAiRequest", () => {
      expect(SandboxContainer.outboundByHost["ai.internal"]).toBe("handleAiRequest");
    });
  });

  describe("handleDbRequest", () => {
    it("executes a SQL query via DB_SERVICE", async () => {
      const env = createEnv();
      const mockResult = { columns: ["id", "name"], rows: [[1, "Item A"]] };
      (env.DB_SERVICE.exec as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      const container = new SandboxContainer(createCtx("agent-1"), env);
      const request = new Request("http://db.internal/exec", {
        method: "POST",
        body: JSON.stringify({ sql: "SELECT * FROM items", params: [], backendId: "agent-1:default" }),
      });

      const response = await container.handleDbRequest(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual(mockResult);
      expect(env.DB_SERVICE.exec).toHaveBeenCalledWith("agent-1:default", "SELECT * FROM items", []);
    });

    it("executes batch statements via DB_SERVICE", async () => {
      const env = createEnv();
      const mockResult = { results: [{ columns: [], rows: [] }] };
      (env.DB_SERVICE.batch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

      const container = new SandboxContainer(createCtx("agent-1"), env);
      const statements = [
        { sql: "INSERT INTO items (name) VALUES (?)", params: ["A"] },
        { sql: "INSERT INTO items (name) VALUES (?)", params: ["B"] },
      ];
      const request = new Request("http://db.internal/batch", {
        method: "POST",
        body: JSON.stringify({ statements, backendId: "agent-1:default" }),
      });

      const response = await container.handleDbRequest(request);

      expect(response.status).toBe(200);
      expect(env.DB_SERVICE.batch).toHaveBeenCalledWith("agent-1:default", statements);
    });

    it("returns 400 when sql is missing from exec", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());
      const request = new Request("http://db.internal/exec", {
        method: "POST",
        body: JSON.stringify({ backendId: "agent-1:default" }),
      });

      const response = await container.handleDbRequest(request);
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe("sql is required");
    });

    it("returns 400 when backendId is missing", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());
      const request = new Request("http://db.internal/exec", {
        method: "POST",
        body: JSON.stringify({ sql: "SELECT 1" }),
      });

      const response = await container.handleDbRequest(request);
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe("backendId is required");
    });

    it("returns 405 for non-POST requests", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());
      const request = new Request("http://db.internal/exec", { method: "GET" });

      const response = await container.handleDbRequest(request);

      expect(response.status).toBe(405);
    });

    it("returns 500 when DB_SERVICE throws", async () => {
      const env = createEnv();
      (env.DB_SERVICE.exec as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB connection failed"));

      const container = new SandboxContainer(createCtx("agent-1"), env);
      const request = new Request("http://db.internal/exec", {
        method: "POST",
        body: JSON.stringify({ sql: "SELECT 1", backendId: "agent-1:default" }),
      });

      const response = await container.handleDbRequest(request);
      const body = (await response.json()) as { error: string };

      expect(response.status).toBe(500);
      expect(body.error).toBe("DB connection failed");
    });

    it("returns 404 for unknown paths", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());
      const request = new Request("http://db.internal/unknown", {
        method: "POST",
        body: JSON.stringify({ backendId: "test" }),
      });

      const response = await container.handleDbRequest(request);

      expect(response.status).toBe(404);
    });
  });

  describe("handleAiRequest", () => {
    it("proxies chat completion requests to OpenRouter", async () => {
      const env = createEnv();
      const container = new SandboxContainer(createCtx("agent-1"), env);

      const mockUpstream = new Response(JSON.stringify({
        choices: [{ message: { content: "Hello!" } }],
      }), {
        headers: { "content-type": "application/json" },
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(mockUpstream);

      try {
        const request = new Request("http://ai.internal/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-4",
            messages: [{ role: "user", content: "Hi" }],
          }),
        });

        const response = await container.handleAiRequest(request);
        const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };

        expect(response.status).toBe(200);
        expect(body.choices[0].message.content).toBe("Hello!");
        expect(globalThis.fetch).toHaveBeenCalledWith(
          "https://openrouter.ai/api/v1/chat/completions",
          expect.objectContaining({
            method: "POST",
            headers: expect.objectContaining({
              authorization: "Bearer test-openrouter-key",
            }),
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns models list for GET /v1/models", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());
      const request = new Request("http://ai.internal/v1/models", { method: "GET" });

      const response = await container.handleAiRequest(request);
      const body = (await response.json()) as { object: string; data: unknown[] };

      expect(response.status).toBe(200);
      expect(body.object).toBe("list");
      expect(body.data).toEqual([]);
    });

    it("returns 500 when OPENROUTER_API_KEY is not configured", async () => {
      const env = createEnv({ OPENROUTER_API_KEY: "" });
      const container = new SandboxContainer(createCtx("agent-1"), env);
      const request = new Request("http://ai.internal/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "test", messages: [] }),
      });

      const response = await container.handleAiRequest(request);

      expect(response.status).toBe(500);
    });

    it("returns 404 for unknown AI endpoints", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());
      const request = new Request("http://ai.internal/v1/unknown", { method: "POST" });

      const response = await container.handleAiRequest(request);

      expect(response.status).toBe(404);
    });

    it("returns 502 when upstream fetch fails", async () => {
      const container = new SandboxContainer(createCtx("agent-1"), createEnv());

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      try {
        const request = new Request("http://ai.internal/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "test", messages: [] }),
        });

        const response = await container.handleAiRequest(request);
        const body = (await response.json()) as { error: string };

        expect(response.status).toBe(502);
        expect(body.error).toContain("Network error");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
