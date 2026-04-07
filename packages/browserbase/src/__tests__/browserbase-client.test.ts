import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserbaseClient } from "../browserbase-client.js";

const TEST_API_KEY = "test-api-key-123";
const TEST_BASE_URL = "https://api.test.browserbase.com";

function mockFetch(response: { status: number; body: unknown }) {
  return vi.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body)),
  });
}

describe("BrowserbaseClient", () => {
  let client: BrowserbaseClient;

  beforeEach(() => {
    client = new BrowserbaseClient(TEST_API_KEY, TEST_BASE_URL);
  });

  describe("createSession", () => {
    it("sends POST to /v1/sessions with correct headers", async () => {
      const sessionResponse = {
        id: "sess-123",
        connectUrl: "wss://connect.browserbase.com/sess-123",
        status: "RUNNING",
        projectId: "proj-1",
        expiresAt: "2026-04-02T12:00:00Z",
        createdAt: "2026-04-02T11:00:00Z",
      };
      const fetch = mockFetch({ status: 201, body: sessionResponse });
      vi.stubGlobal("fetch", fetch);

      const result = await client.createSession({ projectId: "proj-1" });

      expect(fetch).toHaveBeenCalledWith(`${TEST_BASE_URL}/v1/sessions`, {
        method: "POST",
        headers: { "X-BB-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1" }),
      });
      expect(result.id).toBe("sess-123");
      expect(result.connectUrl).toBe("wss://connect.browserbase.com/sess-123");

      vi.unstubAllGlobals();
    });

    it("includes browser settings when provided", async () => {
      const fetch = mockFetch({ status: 201, body: { id: "sess-456", connectUrl: "wss://..." } });
      vi.stubGlobal("fetch", fetch);

      await client.createSession({
        projectId: "proj-1",
        browserSettings: { context: { id: "ctx-1", persist: true } },
      });

      const body = JSON.parse(fetch.mock.calls[0][1].body);
      expect(body.browserSettings.context.id).toBe("ctx-1");
      expect(body.browserSettings.context.persist).toBe(true);

      vi.unstubAllGlobals();
    });

    it("throws on non-OK response", async () => {
      const fetch = mockFetch({ status: 400, body: { error: "bad request" } });
      vi.stubGlobal("fetch", fetch);

      await expect(client.createSession({ projectId: "proj-1" })).rejects.toThrow(
        "Browserbase createSession failed (400)",
      );

      vi.unstubAllGlobals();
    });
  });

  describe("getDebugUrls", () => {
    it("sends GET to /v1/sessions/{id}/debug", async () => {
      const debugResponse = {
        debuggerUrl: "https://debug.browserbase.com/sess-123",
        debuggerFullscreenUrl: "https://debug.browserbase.com/sess-123/fullscreen",
        wsUrl: "wss://debug.browserbase.com/sess-123",
        pages: [
          {
            id: "page-1",
            debuggerUrl: "https://debug.browserbase.com/page-1",
            debuggerFullscreenUrl: "https://debug.browserbase.com/page-1/fullscreen",
            faviconUrl: "",
            title: "Example",
            url: "https://example.com",
          },
        ],
      };
      const fetch = mockFetch({ status: 200, body: debugResponse });
      vi.stubGlobal("fetch", fetch);

      const result = await client.getDebugUrls("sess-123");

      expect(fetch).toHaveBeenCalledWith(`${TEST_BASE_URL}/v1/sessions/sess-123/debug`, {
        headers: { "X-BB-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      });
      expect(result.debuggerFullscreenUrl).toBe(
        "https://debug.browserbase.com/sess-123/fullscreen",
      );
      expect(result.pages).toHaveLength(1);

      vi.unstubAllGlobals();
    });

    it("throws on non-OK response", async () => {
      const fetch = mockFetch({ status: 404, body: { error: "not found" } });
      vi.stubGlobal("fetch", fetch);

      await expect(client.getDebugUrls("bad-id")).rejects.toThrow(
        "Browserbase getDebugUrls failed (404)",
      );

      vi.unstubAllGlobals();
    });
  });

  describe("releaseSession", () => {
    it("sends POST with REQUEST_RELEASE status", async () => {
      const fetch = mockFetch({ status: 200, body: {} });
      vi.stubGlobal("fetch", fetch);

      await client.releaseSession("sess-123");

      expect(fetch).toHaveBeenCalledWith(`${TEST_BASE_URL}/v1/sessions/sess-123`, {
        method: "POST",
        headers: { "X-BB-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "REQUEST_RELEASE" }),
      });

      vi.unstubAllGlobals();
    });

    it("throws on non-OK response", async () => {
      const fetch = mockFetch({ status: 500, body: { error: "server error" } });
      vi.stubGlobal("fetch", fetch);

      await expect(client.releaseSession("sess-123")).rejects.toThrow(
        "Browserbase releaseSession failed (500)",
      );

      vi.unstubAllGlobals();
    });
  });

  describe("createContext", () => {
    it("sends POST to /v1/contexts and returns context ID", async () => {
      const fetch = mockFetch({ status: 201, body: { id: "ctx-abc" } });
      vi.stubGlobal("fetch", fetch);

      const id = await client.createContext("proj-1");

      expect(fetch).toHaveBeenCalledWith(`${TEST_BASE_URL}/v1/contexts`, {
        method: "POST",
        headers: { "X-BB-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1" }),
      });
      expect(id).toBe("ctx-abc");

      vi.unstubAllGlobals();
    });

    it("sends empty body when no projectId", async () => {
      const fetch = mockFetch({ status: 201, body: { id: "ctx-def" } });
      vi.stubGlobal("fetch", fetch);

      await client.createContext();

      const body = JSON.parse(fetch.mock.calls[0][1].body);
      expect(body).toEqual({});

      vi.unstubAllGlobals();
    });

    it("throws on non-OK response", async () => {
      const fetch = mockFetch({ status: 403, body: { error: "forbidden" } });
      vi.stubGlobal("fetch", fetch);

      await expect(client.createContext()).rejects.toThrow(
        "Browserbase createContext failed (403)",
      );

      vi.unstubAllGlobals();
    });
  });
});
