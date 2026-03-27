/**
 * Machine-readable error codes sent to clients via ErrorMessage.
 */
export const ErrorCodes = {
  /** Failed to parse incoming WebSocket message JSON */
  PARSE_ERROR: "PARSE_ERROR",
  /** Requested session does not exist */
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  /** Agent is busy and cannot accept a new prompt */
  AGENT_BUSY: "AGENT_BUSY",
  /** Agent failed to initialize (bad config, missing model, etc.) */
  AGENT_INIT_ERROR: "AGENT_INIT_ERROR",
  /** Tool execution failed */
  TOOL_ERROR: "TOOL_ERROR",
  /** MCP server error */
  MCP_ERROR: "MCP_ERROR",
  /** Catch-all for unexpected internal errors */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
