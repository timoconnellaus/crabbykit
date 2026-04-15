import { describe, expect, it, vi } from "vitest";
import { CloudflareSandboxProvider } from "../src/provider.js";

function mockStub() {
  return {
    fetch: vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ready: true }), { status: 200 })),
  };
}

function mockStorage(namespace = "test-agent") {
  return {
    bucket: () => ({}) as R2Bucket,
    namespace: () => namespace,
  };
}

function createProvider(stub = mockStub(), namespace?: string) {
  return new CloudflareSandboxProvider({
    storage: mockStorage(namespace ?? "test-agent"),
    getStub: () => stub as unknown as DurableObjectStub,
  });
}

describe("CloudflareSandboxProvider", () => {
  describe("start", () => {
    it("calls /health to wake the container", async () => {
      const stub = mockStub();
      const provider = createProvider(stub);

      await provider.start();

      expect(stub.fetch).toHaveBeenCalledWith(
        "http://container/health",
        expect.objectContaining({
          headers: expect.objectContaining({ "content-type": "application/json" }),
        }),
      );
    });

    it("calls /init with envVars when provided", async () => {
      const stub = mockStub();
      const provider = createProvider(stub);

      await provider.start({ envVars: { FOO: "bar" } });

      // Should have called /health first, then /init
      expect(stub.fetch).toHaveBeenCalledTimes(2);
      expect(stub.fetch).toHaveBeenLastCalledWith(
        "http://container/init",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ envVars: { FOO: "bar" } }),
        }),
      );
    });

    it("skips /init when envVars is empty", async () => {
      const stub = mockStub();
      const provider = createProvider(stub);

      await provider.start({ envVars: {} });

      expect(stub.fetch).toHaveBeenCalledTimes(1);
    });

    it("throws on non-ok health response", async () => {
      const stub = mockStub();
      (stub.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response("error", { status: 500 }),
      );
      const provider = createProvider(stub);

      await expect(provider.start()).rejects.toThrow("health check failed: 500");
    });
  });

  describe("stop", () => {
    it("posts to /stop", async () => {
      const stub = mockStub();
      const provider = createProvider(stub);

      await provider.stop();

      expect(stub.fetch).toHaveBeenCalledWith(
        "http://container/stop",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("health", () => {
    it("returns parsed JSON on success", async () => {
      const stub = mockStub();
      (stub.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify({ ready: true, workspace: "/workspace" })),
      );
      const provider = createProvider(stub);

      const result = await provider.health();
      expect(result).toEqual({ ready: true, workspace: "/workspace" });
    });

    it("returns ready:false on failure", async () => {
      const stub = mockStub();
      (stub.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response("error", { status: 503 }),
      );
      const provider = createProvider(stub);

      const result = await provider.health();
      expect(result.ready).toBe(false);
    });
  });

  describe("exec", () => {
    it("posts command and returns result", async () => {
      const stub = mockStub();
      (stub.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify({ stdout: "hello", stderr: "", exitCode: 0 })),
      );
      const provider = createProvider(stub);

      const result = await provider.exec("echo hello", { timeout: 5000, cwd: "/tmp" });

      expect(stub.fetch).toHaveBeenCalledWith(
        "http://container/exec",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ command: "echo hello", timeout: 5000, cwd: "/tmp" }),
        }),
      );
      expect(result).toEqual({ stdout: "hello", stderr: "", exitCode: 0 });
    });

    it("throws on non-ok response", async () => {
      const stub = mockStub();
      (stub.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response("timeout", { status: 504 }),
      );
      const provider = createProvider(stub);

      await expect(provider.exec("sleep 999")).rejects.toThrow("exec failed: 504");
    });
  });

  describe("processStart", () => {
    it("posts to /process-start and returns pid", async () => {
      const stub = mockStub();
      (stub.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify({ pid: 42 })),
      );
      const provider = createProvider(stub);

      const result = await provider.processStart("dev", "npm start", "/app");

      expect(stub.fetch).toHaveBeenCalledWith(
        "http://container/process-start",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "dev", command: "npm start", cwd: "/app" }),
        }),
      );
      expect(result).toEqual({ pid: 42 });
    });
  });

  describe("processStop", () => {
    it("posts to /process-stop", async () => {
      const stub = mockStub();
      const provider = createProvider(stub);

      await provider.processStop("dev");

      expect(stub.fetch).toHaveBeenCalledWith(
        "http://container/process-stop",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "dev" }),
        }),
      );
    });
  });

  describe("processList", () => {
    it("returns parsed process array", async () => {
      const stub = mockStub();
      const procs = [{ name: "dev", command: "npm start", pid: 42, running: true }];
      (stub.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response(JSON.stringify(procs)),
      );
      const provider = createProvider(stub);

      const result = await provider.processList();
      expect(result).toEqual(procs);
    });
  });

  describe("setDevPort", () => {
    it("posts port to /set-dev-port", async () => {
      const stub = mockStub();
      const provider = createProvider(stub);

      await provider.setDevPort(5173);

      expect(stub.fetch).toHaveBeenCalledWith(
        "http://container/set-dev-port",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ port: 5173 }),
        }),
      );
    });

    it("throws on non-ok response", async () => {
      const stub = mockStub();
      (stub.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response("bad port", { status: 400 }),
      );
      const provider = createProvider(stub);

      await expect(provider.setDevPort(-1)).rejects.toThrow("set-dev-port failed: 400");
    });
  });

  describe("clearDevPort", () => {
    it("posts to /clear-dev-port", async () => {
      const stub = mockStub();
      const provider = createProvider(stub);

      await provider.clearDevPort();

      expect(stub.fetch).toHaveBeenCalledWith(
        "http://container/clear-dev-port",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws on non-ok response", async () => {
      const stub = mockStub();
      (stub.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Response("error", { status: 500 }),
      );
      const provider = createProvider(stub);

      await expect(provider.clearDevPort()).rejects.toThrow("clear-dev-port failed: 500");
    });
  });

  describe("headers", () => {
    it("includes x-agent-id from storage namespace", async () => {
      const stub = mockStub();
      const provider = createProvider(stub, "agent-123");

      await provider.health();

      expect(stub.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-agent-id": "agent-123",
            "content-type": "application/json",
          }),
        }),
      );
    });
  });
});
