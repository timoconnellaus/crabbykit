import { describe, expect, it } from "vitest";
import { defineBundleAgent } from "../define.js";
import type { BundleEnv } from "../types.js";

describe("defineBundleAgent", () => {
  const minimalSetup = {
    model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4" },
    prompt: { agentName: "TestBundle" },
  };

  it("returns a fetch handler", () => {
    const bundle = defineBundleAgent(minimalSetup);
    expect(bundle).toBeDefined();
    expect(typeof bundle.fetch).toBe("function");
  });

  describe("POST /metadata", () => {
    it("returns declared metadata", async () => {
      const bundle = defineBundleAgent({
        ...minimalSetup,
        metadata: { name: "Helper", description: "research assistant" },
      });

      const res = await bundle.fetch(
        new Request("https://bundle/metadata", { method: "POST" }),
        {} as BundleEnv,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ name: "Helper", description: "research assistant" });
    });

    it("returns empty object when no metadata declared", async () => {
      const bundle = defineBundleAgent(minimalSetup);

      const res = await bundle.fetch(
        new Request("https://bundle/metadata", { method: "POST" }),
        {} as BundleEnv,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({});
    });
  });

  describe("POST /smoke", () => {
    it("returns ok with model info", async () => {
      const bundle = defineBundleAgent(minimalSetup);

      const res = await bundle.fetch(new Request("https://bundle/smoke", { method: "POST" }), {
        __BUNDLE_TOKEN: "test-token",
      } as BundleEnv);

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.model).toBe("openrouter/anthropic/claude-sonnet-4");
      expect(body.hasToken).toBe(true);
    });

    it("works with model as function", async () => {
      const bundle = defineBundleAgent({
        model: () => ({ provider: "anthropic", modelId: "claude-sonnet-4" }),
      });

      const res = await bundle.fetch(
        new Request("https://bundle/smoke", { method: "POST" }),
        {} as BundleEnv,
      );

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.model).toBe("anthropic/claude-sonnet-4");
    });
  });

  describe("POST /turn", () => {
    it("rejects without bundle token", async () => {
      const bundle = defineBundleAgent(minimalSetup);

      const res = await bundle.fetch(
        new Request("https://bundle/turn", {
          method: "POST",
          body: JSON.stringify({ prompt: "hello" }),
        }),
        {} as BundleEnv,
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Missing __BUNDLE_TOKEN");
    });

    it("rejects without SPINE binding", async () => {
      const bundle = defineBundleAgent(minimalSetup);

      const res = await bundle.fetch(
        new Request("https://bundle/turn", {
          method: "POST",
          body: JSON.stringify({
            prompt: "hello",
            agentId: "agent-1",
            sessionId: "session-1",
          }),
        }),
        {
          __BUNDLE_TOKEN: "test-token",
        } as BundleEnv,
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("SPINE");
    });
  });

  describe("POST /client-event", () => {
    it("acknowledges client events", async () => {
      const bundle = defineBundleAgent(minimalSetup);

      const res = await bundle.fetch(
        new Request("https://bundle/client-event", {
          method: "POST",
          body: JSON.stringify({ type: "steer", content: "be concise" }),
        }),
        { __BUNDLE_TOKEN: "test-token" } as BundleEnv,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("acknowledged");
    });
  });

  describe("unknown endpoint", () => {
    it("returns 404", async () => {
      const bundle = defineBundleAgent(minimalSetup);

      const res = await bundle.fetch(new Request("https://bundle/unknown"), {} as BundleEnv);

      expect(res.status).toBe(404);
    });
  });
});
