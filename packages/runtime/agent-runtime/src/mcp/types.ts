export interface McpServerConfig {
  name: string;
  serverUrl: string;
  authType: "none" | "oauth" | "api_key";
  authData?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export type McpServerConnectionStatus = "connected" | "disconnected" | "error";

export interface McpServerStatus {
  id: string;
  name: string;
  serverUrl: string;
  status: McpServerConnectionStatus;
  toolCount: number;
  error?: string;
}
