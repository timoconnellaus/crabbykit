/** Options for the browserbase capability factory. */
export interface BrowserbaseOptions {
  /** Browserbase API key. */
  apiKey: string;
  /** Browserbase project ID. */
  projectId: string;
  /** Browserbase Context ID for persistent browser profiles. Created once, reused across sessions. */
  contextId?: string;
  /** Per-minute cost in USD for Browserbase sessions. Defaults to 0.002 ($0.12/hr). */
  perMinuteCostUsd?: number;
  /** Seconds of inactivity before auto-closing the browser session. Defaults to 300 (5 min). */
  idleTimeout?: number;
  /** Maximum session duration in seconds. Defaults to 1800 (30 min). */
  maxDuration?: number;
}

/** A cookie from the browser, matching CDP Network.Cookie shape. */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  priority?: "Low" | "Medium" | "High";
  sameParty?: boolean;
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
  sourcePort?: number;
  partitionKey?: string;
}

/** Persisted browser state (agent-scoped shared cookie jar). */
export interface BrowserState {
  cookies: Cookie[];
  lastUrl?: string;
  savedAt: string;
}

/** Tracks an active browser session for a chat session. */
export interface ActiveSession {
  browserbaseId: string;
  /** CDP WebSocket connect URL for reconnecting after capability cache clear. */
  connectUrl: string;
  /** Whether this session used Browserbase Context with persist=true. */
  usedContext: boolean;
  startedAt: string;
}

/** Response from Browserbase POST /v1/sessions. */
export interface BrowserbaseSession {
  id: string;
  connectUrl: string;
  status: string;
  projectId: string;
  expiresAt: string;
  createdAt: string;
}

/** Response from Browserbase GET /v1/sessions/{id}/debug. */
export interface BrowserbaseDebugUrls {
  debuggerUrl: string;
  debuggerFullscreenUrl: string;
  wsUrl: string;
  pages: Array<{
    id: string;
    debuggerUrl: string;
    debuggerFullscreenUrl: string;
    faviconUrl: string;
    title: string;
    url: string;
  }>;
}

/** Parameters for creating a Browserbase session. */
export interface CreateSessionParams {
  projectId: string;
  browserSettings?: {
    context?: {
      id: string;
      persist?: boolean;
    };
  };
}

/** CDP JSON-RPC request message. */
export interface CDPRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** CDP JSON-RPC response message. */
export interface CDPResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** CDP event message (no id field). */
export interface CDPEvent {
  method: string;
  params?: Record<string, unknown>;
}

/** A node from the CDP Accessibility.getFullAXTree response. */
export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { type: string; value: string };
  name?: { type: string; value: string; sources?: unknown[] };
  description?: { type: string; value: string };
  value?: { type: string; value: unknown };
  properties?: Array<{
    name: string;
    value: { type: string; value: unknown };
  }>;
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
}

/** Ref map mapping ref IDs to AX node metadata. */
export interface RefMap {
  [ref: string]: {
    nodeId: string;
    backendDOMNodeId?: number;
    role: string;
    name: string;
  };
}

/** Result of a snapshot operation. */
export interface SnapshotResult {
  tree: string;
  refs: RefMap;
  url: string;
  title: string;
}
