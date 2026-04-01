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

function createEnv(overrides?: Partial<Record<string, string>>) {
  return {
    AWS_ACCESS_KEY_ID: "AKID",
    AWS_SECRET_ACCESS_KEY: "secret",
    R2_ACCOUNT_ID: "acct-123",
    R2_BUCKET_NAME: "my-bucket",
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
});
