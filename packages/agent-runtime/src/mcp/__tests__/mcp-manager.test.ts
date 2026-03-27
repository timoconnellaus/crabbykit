import { describe, it, expect, beforeEach } from "vitest";
import { McpManager } from "../mcp-manager.js";
import { createMockSqlStorage } from "../../test-helpers/mock-sql-storage.js";

describe("McpManager", () => {
  let manager: McpManager;
  let statusChangeCalled: number;

  beforeEach(() => {
    statusChangeCalled = 0;
    manager = new McpManager(createMockSqlStorage(), () => {
      statusChangeCalled++;
    });
  });

  describe("Registration", () => {
    it("registers an MCP server", async () => {
      const status = await manager.register({
        name: "github",
        serverUrl: "https://github.mcp.example.com",
        authType: "none",
      });

      expect(status.id).toBeTruthy();
      expect(status.name).toBe("github");
      expect(status.serverUrl).toBe("https://github.mcp.example.com");
      expect(statusChangeCalled).toBe(1);
    });

    it("lists registered servers", async () => {
      await manager.register({
        name: "github",
        serverUrl: "https://github.example.com",
        authType: "none",
      });
      await manager.register({
        name: "slack",
        serverUrl: "https://slack.example.com",
        authType: "api_key",
        authData: { key: "xoxb-123" },
      });

      const servers = manager.listServers();
      expect(servers).toHaveLength(2);
      expect(servers.map((s) => s.name)).toContain("github");
      expect(servers.map((s) => s.name)).toContain("slack");
    });

    it("removes a server", async () => {
      const status = await manager.register({
        name: "to-remove",
        serverUrl: "https://example.com",
        authType: "none",
      });

      manager.remove(status.id);

      const servers = manager.listServers();
      expect(servers).toHaveLength(0);
      expect(statusChangeCalled).toBe(2); // register + remove
    });
  });

  describe("Tools", () => {
    it("returns empty tools when no servers connected", () => {
      expect(manager.getTools()).toHaveLength(0);
    });

    it("returns tools from connected servers", async () => {
      // Create a manager subclass that connects successfully with tools
      class ConnectedManager extends McpManager {
        protected async connect(id: string, config: any): Promise<any> {
          // Simulate a connected server with tools
          (this as any).connections.set(id, {
            status: "connected",
            tools: [{
              name: "mcp_test_search",
              label: "mcp_test_search",
              description: "Search",
              parameters: {},
              execute: async () => ({ content: [], details: {} }),
            }],
          });
          return { id, name: config.name, serverUrl: config.serverUrl, status: "connected", toolCount: 1 };
        }
      }

      const m = new ConnectedManager(createMockSqlStorage());
      await m.register({
        name: "test",
        serverUrl: "https://example.com",
        authType: "none",
      });

      const tools = m.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("mcp_test_search");
    });

    it("returns empty tools when servers disconnected", async () => {
      await manager.register({
        name: "test",
        serverUrl: "https://example.com",
        authType: "none",
      });

      const tools = manager.getTools();
      expect(tools).toHaveLength(0);
    });
  });

  describe("Hibernation Recovery", () => {
    it("restores connections from SQLite on wake", async () => {
      const sql = createMockSqlStorage();
      const m1 = new McpManager(sql);

      await m1.register({
        name: "persisted",
        serverUrl: "https://persisted.example.com",
        authType: "none",
      });

      // Create new manager with same storage (simulating wake)
      const m2 = new McpManager(sql);
      await m2.restoreConnections();

      const servers = m2.listServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe("persisted");
    });

    it("handles connection failure on restore", async () => {
      const sql = createMockSqlStorage();

      // Create a manager subclass that fails to connect
      class FailingManager extends McpManager {
        protected async connect(): Promise<any> {
          throw new Error("Connection failed");
        }
      }

      const m1 = new McpManager(sql);
      await m1.register({
        name: "will-fail",
        serverUrl: "https://fail.example.com",
        authType: "none",
      });

      const m2 = new FailingManager(sql);
      await m2.restoreConnections(); // Should not throw

      const servers = m2.listServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].status).toBe("error");
      expect(servers[0].error).toContain("Failed to reconnect");
    });

    it("restores with auth data and options", async () => {
      const sql = createMockSqlStorage();
      const m1 = new McpManager(sql);

      await m1.register({
        name: "with-auth",
        serverUrl: "https://auth.example.com",
        authType: "oauth",
        authData: { token: "abc" },
        options: { timeout: 5000 },
      });

      const m2 = new McpManager(sql);
      await m2.restoreConnections();

      const servers = m2.listServers();
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe("with-auth");
    });
  });

  describe("Connection Status", () => {
    it("shows servers with error when connection fails", async () => {
      await manager.register({
        name: "test",
        serverUrl: "https://example.com",
        authType: "none",
      });

      const servers = manager.listServers();
      // Server goes to error because there's no real MCP server to connect to
      expect(servers[0].status).toBe("error");
      expect(servers[0].toolCount).toBe(0);
    });

    it("handles auth data in registration", async () => {
      const status = await manager.register({
        name: "oauth-server",
        serverUrl: "https://oauth.example.com",
        authType: "oauth",
        authData: { clientId: "abc", clientSecret: "xyz" },
      });
      expect(status.name).toBe("oauth-server");
    });

    it("handles options in registration", async () => {
      const status = await manager.register({
        name: "with-opts",
        serverUrl: "https://example.com",
        authType: "none",
        options: { timeout: 5000 },
      });
      expect(status.name).toBe("with-opts");
    });
  });

  describe("Status Broadcasting", () => {
    it("calls onStatusChange on register", async () => {
      await manager.register({
        name: "test",
        serverUrl: "https://example.com",
        authType: "none",
      });
      expect(statusChangeCalled).toBe(1);
    });

    it("calls onStatusChange on remove", async () => {
      const status = await manager.register({
        name: "test",
        serverUrl: "https://example.com",
        authType: "none",
      });
      manager.remove(status.id);
      expect(statusChangeCalled).toBe(2);
    });

    it("calls onStatusChange on restore", async () => {
      await manager.restoreConnections();
      expect(statusChangeCalled).toBe(1);
    });
  });
});
