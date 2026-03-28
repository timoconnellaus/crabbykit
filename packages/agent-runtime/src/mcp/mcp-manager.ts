import type { AgentTool } from "@claw-for-cloudflare/agent-core";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ContentBlock, TextContent, Tool } from "@modelcontextprotocol/sdk/types.js";
import { mcpToolToAgentTool } from "../tools/define-tool.js";
import type { McpServerConfig, McpServerConnectionStatus, McpServerStatus } from "./types.js";

// Lazy-loaded MCP SDK imports (avoids ajv CJS issues in Workers test pool)
async function loadMcpSdk() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );
  const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
  // biome-ignore lint/style/useNamingConvention: class names from MCP SDK use PascalCase
  return { Client, StreamableHTTPClientTransport, SSEClientTransport };
}

const CLIENT_INFO = { name: "claw-agent-runtime", version: "0.1.0" };

/**
 * MCP Client Manager backed by DO SQLite.
 * Handles server registration, connection management, tool discovery,
 * OAuth flows, and hibernation recovery.
 */
export class McpManager {
  private sql: SqlStorage;
  private connections = new Map<string, McpConnection>();
  private onStatusChange?: () => void;

  constructor(sql: SqlStorage, onStatusChange?: () => void) {
    this.sql = sql;
    this.onStatusChange = onStatusChange;
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        server_url TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'none',
        auth_data TEXT,
        options TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  async register(config: McpServerConfig): Promise<McpServerStatus> {
    const id = crypto.randomUUID();

    this.sql.exec(
      "INSERT INTO mcp_servers (id, name, server_url, auth_type, auth_data, options) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      config.name,
      config.serverUrl,
      config.authType,
      config.authData ? JSON.stringify(config.authData) : null,
      config.options ? JSON.stringify(config.options) : null,
    );

    const status = await this.connect(id, config);
    this.onStatusChange?.();
    return status;
  }

  remove(serverId: string): void {
    this.disconnect(serverId);
    this.sql.exec("DELETE FROM mcp_servers WHERE id = ?", serverId);
    this.onStatusChange?.();
  }

  listServers(): McpServerStatus[] {
    const rows = this.sql.exec("SELECT * FROM mcp_servers ORDER BY created_at").toArray();

    return rows.map((row) => {
      const id = row.id as string;
      const conn = this.connections.get(id);
      return {
        id,
        name: row.name as string,
        serverUrl: row.server_url as string,
        status: conn?.status ?? ("disconnected" as McpServerConnectionStatus),
        toolCount: conn?.tools.length ?? 0,
        error: conn?.error,
      };
    });
  }

  getTools(): AgentTool[] {
    const tools: AgentTool[] = [];
    for (const conn of this.connections.values()) {
      if (conn.status === "connected") {
        tools.push(...conn.tools);
      }
    }
    return tools;
  }

  async restoreConnections(): Promise<void> {
    const rows = this.sql.exec("SELECT * FROM mcp_servers").toArray();

    for (const row of rows) {
      const config: McpServerConfig = {
        name: row.name as string,
        serverUrl: row.server_url as string,
        authType: row.auth_type as McpServerConfig["authType"],
        authData: row.auth_data ? JSON.parse(row.auth_data as string) : undefined,
        options: row.options ? JSON.parse(row.options as string) : undefined,
      };

      try {
        await this.connect(row.id as string, config);
      } catch {
        this.connections.set(row.id as string, {
          status: "error",
          tools: [],
          error: "Failed to reconnect after hibernation",
        });
      }
    }

    this.onStatusChange?.();
  }

  /**
   * Handle OAuth callback — exchange code for tokens and reconnect.
   */
  async handleOAuthCallback(serverId: string, authorizationCode: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn?.oauthProvider) {
      throw new Error(`No OAuth provider for server ${serverId}`);
    }

    // Store the auth code for the provider to use on next connect
    const row = this.sql.exec("SELECT * FROM mcp_servers WHERE id = ?", serverId).one();
    if (!row) throw new Error(`Server not found: ${serverId}`);

    // Update auth_data with the authorization code
    const authData = row.auth_data ? JSON.parse(row.auth_data as string) : {};
    authData.authorizationCode = authorizationCode;
    this.sql.exec(
      "UPDATE mcp_servers SET auth_data = ? WHERE id = ?",
      JSON.stringify(authData),
      serverId,
    );

    // Reconnect — the OAuth provider will use the stored code
    const config: McpServerConfig = {
      name: row.name as string,
      serverUrl: row.server_url as string,
      authType: "oauth",
      authData,
      options: row.options ? JSON.parse(row.options as string) : undefined,
    };

    await this.connect(serverId, config);
    this.onStatusChange?.();
  }

  // --- Connection (protected for testability) ---

  protected async connect(id: string, config: McpServerConfig): Promise<McpServerStatus> {
    // Close existing connection if any
    this.disconnect(id);

    const conn: McpConnection = {
      status: "disconnected",
      tools: [],
    };
    this.connections.set(id, conn);

    try {
      const sdk = await loadMcpSdk();

      // Create transport based on server URL and auth type
      const transport = this.createTransport(config, sdk);

      // Create MCP client
      const client = new sdk.Client(CLIENT_INFO);
      await client.connect(transport);

      conn.client = client;
      conn.status = "connected";

      // Discover tools
      await this.discoverTools(id, config.name, client);
    } catch (err: unknown) {
      conn.status = "error";
      conn.error = err instanceof Error ? err.message : "Connection failed";

      // If it's an auth error and we have OAuth config, provide auth URL
      if (config.authType === "oauth" && !config.authData?.authorizationCode) {
        conn.authUrl = config.authData?.authUrl as string | undefined;
      }
    }

    return {
      id,
      name: config.name,
      serverUrl: config.serverUrl,
      status: conn.status,
      toolCount: conn.tools.length,
      error: conn.error,
    };
  }

  /**
   * Discover tools from a connected MCP server and convert to AgentTool[].
   */
  private async discoverTools(serverId: string, serverName: string, client: Client): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;

    const result = await client.listTools();

    // Create an MCP server adapter for tool execution
    const server = {
      name: serverName,
      callTool: async (toolName: string, args: Record<string, unknown>) => {
        const callResult = await client.callTool({
          name: toolName,
          arguments: args,
        });

        // Extract text content from MCP result
        const textParts = (callResult.content as ContentBlock[])
          ?.filter((c: ContentBlock): c is TextContent => c.type === "text")
          .map((c: TextContent) => c.text)
          .join("\n");

        return {
          content: textParts || JSON.stringify(callResult.content),
          isError: (callResult.isError as boolean) ?? false,
        };
      },
    };

    // Convert each MCP tool to an AgentTool
    conn.tools = result.tools.map((tool: Tool) =>
      mcpToolToAgentTool(
        {
          name: tool.name,
          description: tool.description,
          inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
        },
        server,
      ),
    );
  }

  private createTransport(
    config: McpServerConfig,
    sdk: Awaited<ReturnType<typeof loadMcpSdk>>,
  ):
    | InstanceType<typeof sdk.StreamableHTTPClientTransport>
    | InstanceType<typeof sdk.SSEClientTransport> {
    const url = new URL(config.serverUrl);

    // Build OAuth provider if needed
    let authProvider: OAuthClientProvider | undefined;
    if (config.authType === "oauth" && config.authData) {
      authProvider = this.createOAuthProvider(config);
    }

    // Build request headers for API key auth
    const headers: Record<string, string> = {};
    if (config.authType === "api_key" && config.authData?.key) {
      headers.Authorization = `Bearer ${config.authData.key}`;
    }

    // Use SSE for legacy endpoints, StreamableHTTP for modern
    const useSse = config.options?.transport === "sse";

    if (useSse) {
      return new sdk.SSEClientTransport(url, {
        requestInit: { headers },
        authProvider,
      });
    }

    return new sdk.StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      authProvider,
    });
  }

  private createOAuthProvider(config: McpServerConfig): OAuthClientProvider {
    const authData = config.authData ?? {};

    return {
      get redirectUrl() {
        return authData.redirectUrl as string | undefined;
      },
      get clientMetadata() {
        return {
          client_name: `claw-agent-${config.name}`,
          redirect_uris: authData.redirectUrl ? [authData.redirectUrl as string] : [],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
          // biome-ignore lint/suspicious/noExplicitAny: OAuthClientMetadata requires fields not statically known
        } as any;
      },
      async clientInformation() {
        if (authData.clientId) {
          return {
            client_id: authData.clientId as string,
            client_secret: authData.clientSecret as string | undefined,
            // biome-ignore lint/suspicious/noExplicitAny: OAuthClientInformationMixed shape varies at runtime
          } as any;
        }
        return undefined;
      },
      // biome-ignore lint/suspicious/noExplicitAny: MCP SDK OAuthClientProvider callback parameter
      async saveClientInformation(info: any) {
        // Persist back to SQL
        authData.clientId = info.client_id;
        authData.clientSecret = info.client_secret;
      },
      async tokens() {
        if (authData.accessToken) {
          return {
            access_token: authData.accessToken as string,
            refresh_token: authData.refreshToken as string | undefined,
            token_type: "bearer",
            // biome-ignore lint/suspicious/noExplicitAny: OAuthTokens shape varies at runtime
          } as any;
        }
        return undefined;
      },
      // biome-ignore lint/suspicious/noExplicitAny: MCP SDK OAuthClientProvider callback parameter
      async saveTokens(tokens: any) {
        authData.accessToken = tokens.access_token;
        authData.refreshToken = tokens.refresh_token;
      },
      async redirectToAuthorization(authUrl: URL) {
        // Store the auth URL — it will be returned to the client via status
        authData.authUrl = authUrl.toString();
      },
      async saveCodeVerifier(verifier: string) {
        authData.codeVerifier = verifier;
      },
      async codeVerifier() {
        return authData.codeVerifier as string;
      },
    } as OAuthClientProvider;
  }

  protected disconnect(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (conn?.client) {
      conn.client.close().catch(() => {});
    }
    this.connections.delete(serverId);
  }
}

interface McpConnection {
  status: McpServerConnectionStatus;
  tools: AgentTool[];
  error?: string;
  client?: Client;
  authUrl?: string;
  oauthProvider?: OAuthClientProvider;
}
