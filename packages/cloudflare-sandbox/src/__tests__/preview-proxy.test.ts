import { describe, expect, it, vi } from "vitest";
import { handlePreviewRequest } from "../preview-proxy.js";

function mockNamespace(hexId = "abc123hex") {
  const stubFetch = vi.fn().mockResolvedValue(new Response("proxied"));
  const stub = { fetch: stubFetch };

  return {
    namespace: {
      idFromName: vi.fn().mockReturnValue({ toString: () => hexId }),
      get: vi.fn().mockReturnValue(stub),
    } as unknown as DurableObjectNamespace,
    stubFetch,
  };
}

function createOpts(
  url: string,
  overrides?: { agentHexId?: string; containerHexId?: string },
) {
  const agent = mockNamespace(overrides?.agentHexId ?? "agent-hex-id");
  const container = mockNamespace(overrides?.containerHexId ?? "container-hex-id");

  return {
    opts: {
      request: new Request(url),
      agentNamespace: agent.namespace,
      containerNamespace: container.namespace,
    },
    agent,
    container,
  };
}

describe("handlePreviewRequest", () => {
  describe("path matching", () => {
    it("returns null for non-preview paths", () => {
      const { opts } = createOpts("http://example.com/api/health");
      expect(handlePreviewRequest(opts)).toBeNull();
    });

    it("returns null for root path", () => {
      const { opts } = createOpts("http://example.com/");
      expect(handlePreviewRequest(opts)).toBeNull();
    });

    it("returns null for /preview without an ID", () => {
      const { opts } = createOpts("http://example.com/preview/");
      // The regex requires at least one non-slash character after /preview/
      expect(handlePreviewRequest(opts)).toBeNull();
    });

    it("returns null for /preview alone (no trailing slash)", () => {
      const { opts } = createOpts("http://example.com/preview");
      expect(handlePreviewRequest(opts)).toBeNull();
    });

    it("returns a Promise for /preview/:id paths", () => {
      const { opts } = createOpts("http://example.com/preview/abc123");
      const result = handlePreviewRequest(opts);
      expect(result).toBeInstanceOf(Promise);
    });

    it("returns a Promise for /preview/:id/subpath paths", () => {
      const { opts } = createOpts("http://example.com/preview/abc123/assets/main.js");
      const result = handlePreviewRequest(opts);
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe("UUID normalization", () => {
    it("normalizes UUIDs (with dashes) via agentNamespace.idFromName", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const { opts, agent, container } = createOpts(
        `http://example.com/preview/${uuid}/index.html`,
        { agentHexId: "normalized-hex" },
      );

      await handlePreviewRequest(opts);

      // UUID should be passed to agentNamespace.idFromName for normalization
      expect(agent.namespace.idFromName).toHaveBeenCalledWith(uuid);
      // The normalized hex ID should be used for the container lookup
      expect(container.namespace.idFromName).toHaveBeenCalledWith("normalized-hex");
    });

    it("passes hex IDs through without normalization", async () => {
      const hexId = "abc123def456";
      const { opts, agent, container } = createOpts(
        `http://example.com/preview/${hexId}`,
      );

      await handlePreviewRequest(opts);

      // No dashes means no UUID normalization
      expect(agent.namespace.idFromName).not.toHaveBeenCalled();
      // The raw hex ID should be used directly
      expect(container.namespace.idFromName).toHaveBeenCalledWith(hexId);
    });
  });

  describe("container proxying", () => {
    it("proxies to container with correct URL for root subpath", async () => {
      const hexId = "abc123";
      const { opts, container } = createOpts(
        `http://example.com/preview/${hexId}`,
      );

      await handlePreviewRequest(opts);

      expect(container.stubFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `http://container/preview/${hexId}/`,
        }),
      );
    });

    it("proxies to container with correct URL including subpath", async () => {
      const hexId = "abc123";
      const { opts, container } = createOpts(
        `http://example.com/preview/${hexId}/assets/style.css`,
      );

      await handlePreviewRequest(opts);

      expect(container.stubFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `http://container/preview/${hexId}/assets/style.css`,
        }),
      );
    });

    it("preserves query string parameters", async () => {
      const hexId = "abc123";
      const { opts, container } = createOpts(
        `http://example.com/preview/${hexId}/page?foo=bar&baz=1`,
      );

      await handlePreviewRequest(opts);

      expect(container.stubFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `http://container/preview/${hexId}/page?foo=bar&baz=1`,
        }),
      );
    });

    it("returns the container response", async () => {
      const { opts } = createOpts("http://example.com/preview/abc123");

      const response = await handlePreviewRequest(opts);

      expect(response).toBeInstanceOf(Response);
      expect(await response!.text()).toBe("proxied");
    });

    it("creates container stub from the containerNamespace", async () => {
      const { opts, container } = createOpts("http://example.com/preview/abc123");

      await handlePreviewRequest(opts);

      expect(container.namespace.idFromName).toHaveBeenCalledWith("abc123");
      expect(container.namespace.get).toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("handles deeply nested subpaths", async () => {
      const hexId = "abc123";
      const { opts, container } = createOpts(
        `http://example.com/preview/${hexId}/a/b/c/d/e.js`,
      );

      await handlePreviewRequest(opts);

      expect(container.stubFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `http://container/preview/${hexId}/a/b/c/d/e.js`,
        }),
      );
    });

    it("handles IDs with only a single dash (not a UUID)", async () => {
      // A single dash makes rawId.includes("-") true, so it goes through normalization
      const idWithDash = "agent-1";
      const { opts, agent } = createOpts(
        `http://example.com/preview/${idWithDash}`,
        { agentHexId: "resolved-hex" },
      );

      await handlePreviewRequest(opts);

      expect(agent.namespace.idFromName).toHaveBeenCalledWith(idWithDash);
    });

    it("handles empty query string", async () => {
      const hexId = "abc123";
      const { opts, container } = createOpts(
        `http://example.com/preview/${hexId}/path`,
      );

      await handlePreviewRequest(opts);

      expect(container.stubFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `http://container/preview/${hexId}/path`,
        }),
      );
    });
  });
});
