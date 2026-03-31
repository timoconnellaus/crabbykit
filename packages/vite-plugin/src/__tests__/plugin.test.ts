import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clawForCloudflare } from "../plugin";

// Save and restore env vars between tests
const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  // Clear CLAW env vars
  setEnv("AGENT_ID", undefined);
  setEnv("CLAW_PREVIEW_BASE", undefined);
  setEnv("CLAW_PREVIEW_PORT", undefined);
});

afterEach(() => {
  // Restore original env
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("clawForCloudflare", () => {
  it("returns a plugin with the correct name", () => {
    const plugin = clawForCloudflare();
    expect(plugin.name).toBe("claw-for-cloudflare");
  });

  it("is a no-op when no AGENT_ID or CLAW_PREVIEW_BASE is set", () => {
    const plugin = clawForCloudflare();
    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    const result = (plugin as any).config({}, { command: "serve", mode: "development" });
    expect(result).toBeUndefined();
  });

  it("is a no-op during build command", () => {
    setEnv("AGENT_ID", "test-agent-123");
    const plugin = clawForCloudflare();
    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    const result = (plugin as any).config({}, { command: "build", mode: "production" });
    expect(result).toBeUndefined();
  });

  it("configures base path from AGENT_ID", () => {
    setEnv("AGENT_ID", "abc123");
    const plugin = clawForCloudflare();
    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    const result = (plugin as any).config({}, { command: "serve", mode: "development" });

    expect(result).toBeDefined();
    // Should NOT set base (Vite serves from /, proxy strips prefix)
    expect(result.base).toBeUndefined();
    expect(result.server.host).toBe(true);
    expect(result.server.port).toBe(3000);
    expect(result.server.strictPort).toBe(true);
  });

  it("uses CLAW_PREVIEW_PORT for server port", () => {
    setEnv("AGENT_ID", "abc123");
    setEnv("CLAW_PREVIEW_PORT", "4000");
    const plugin = clawForCloudflare();
    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    const result = (plugin as any).config({}, { command: "serve", mode: "development" });

    expect(result.server.port).toBe(4000);
  });

  it("accepts explicit port option over env vars", () => {
    setEnv("AGENT_ID", "abc123");
    const plugin = clawForCloudflare({ port: 5000 });
    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    const result = (plugin as any).config({}, { command: "serve", mode: "development" });

    expect(result.server.port).toBe(5000);
  });

  it("injects base tag and console capture script when active", () => {
    setEnv("AGENT_ID", "abc123");
    const plugin = clawForCloudflare();
    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    (plugin as any).config({}, { command: "serve", mode: "development" });

    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    const tags = (plugin as any).transformIndexHtml("");
    expect(tags).toHaveLength(2);
    // First tag: <base href>
    expect(tags[0].tag).toBe("base");
    expect(tags[0].attrs.href).toBe("/preview/abc123/");
    expect(tags[0].injectTo).toBe("head-prepend");
    // Second tag: console capture script
    expect(tags[1].tag).toBe("script");
    expect(tags[1].children).toContain("claw:console");
  });

  it("uses custom base in base tag", () => {
    const plugin = clawForCloudflare({ base: "/custom/path" });
    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    (plugin as any).config({}, { command: "serve", mode: "development" });

    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    const tags = (plugin as any).transformIndexHtml("");
    expect(tags[0].attrs.href).toBe("/custom/path/");
  });

  it("does not inject tags when inactive", () => {
    const plugin = clawForCloudflare();
    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    (plugin as any).config({}, { command: "serve", mode: "development" });

    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    const tags = (plugin as any).transformIndexHtml("");
    expect(tags).toHaveLength(0);
  });

  it("respects consoleCapture: false — still injects base tag", () => {
    setEnv("AGENT_ID", "abc123");
    const plugin = clawForCloudflare({ consoleCapture: false });
    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    (plugin as any).config({}, { command: "serve", mode: "development" });

    // biome-ignore lint/suspicious/noExplicitAny: testing internal hook
    const tags = (plugin as any).transformIndexHtml("");
    // Only the base tag, no console script
    expect(tags).toHaveLength(1);
    expect(tags[0].tag).toBe("base");
  });
});
