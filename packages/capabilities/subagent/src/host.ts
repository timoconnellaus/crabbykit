/**
 * Interface that the hosting AgentDO must satisfy to support subagent execution.
 * Consumers pass their AgentDO (or a wrapper) as the host.
 *
 * This decouples the subagent tools from AgentDO internals,
 * making them testable with mock hosts.
 */
export interface SubagentHost {
  /**
   * Create a new session for a subagent.
   * Should call sessionStore.create() with source: "subagent".
   */
  createSubagentSession(opts: { name: string; parentSessionId: string }): { id: string };

  /**
   * Run a subagent to completion (blocking).
   * Creates an Agent instance with the given config, runs prompt, waits for
   * agent_end, and returns the final assistant message text.
   */
  runSubagentBlocking(opts: SubagentRunOpts): Promise<SubagentRunResult>;

  /**
   * Start a subagent without waiting (non-blocking).
   * Creates an Agent instance, starts the prompt, and returns immediately.
   * Calls onComplete when the agent finishes.
   */
  startSubagentAsync(opts: SubagentRunOpts, onComplete: (result: SubagentRunResult) => void): void;

  /**
   * Check if a session's agent is currently streaming.
   */
  isSessionStreaming(sessionId: string): boolean;

  /**
   * Steer a running session with a message (persists + injects mid-turn).
   */
  steerSession(sessionId: string, text: string): void;

  /**
   * Send a prompt to a session, starting new inference.
   */
  promptSession(sessionId: string, text: string): Promise<void>;

  /**
   * Abort a running agent for a session.
   */
  abortSession(sessionId: string): Promise<void>;

  /**
   * Broadcast a server message to a specific session's WebSocket connections.
   */
  broadcastToSession(sessionId: string, message: unknown): void;
}

export interface SubagentRunOpts {
  childSessionId: string;
  systemPrompt: string;
  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance
  tools: any[];
  modelId?: string;
  prompt: string;
}

export interface SubagentRunResult {
  /** The final assistant response text. */
  responseText: string;
  /** Whether the agent completed successfully or errored. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
}
