import type { SubagentHost, SubagentRunOpts, SubagentRunResult } from "./host.js";

/**
 * Delegate interface — the AgentDO members the host needs access to.
 * Consumers pass `this` from their AgentDO subclass.
 *
 * All properties map to protected AgentDO members.
 */
export interface AgentDODelegate {
  /** SessionStore.create() */
  createSession: (opts: { name?: string; source?: string }) => { id: string; name: string };
  /** SessionStore.appendEntry() */
  appendEntry: (
    sessionId: string,
    entry: { type: string; data: Record<string, unknown> },
  ) => unknown;
  /** Check if a session's agent is streaming */
  isStreaming: (sessionId: string) => boolean;
  /** Steer a running session (persist + inject mid-turn) */
  steerSession: (sessionId: string, text: string, broadcast?: boolean) => void;
  /** Send a prompt to a session (starts new inference) */
  promptSession: (opts: { text: string; sessionId: string; source: string }) => Promise<unknown>;
  /** Abort a running session's agent */
  abortSession: (sessionId: string) => Promise<void>;
  /** Run an agent for a child session (blocking — waits for completion) */
  runAgentForSession: (opts: SubagentRunOpts) => Promise<SubagentRunResult>;
  /** Start an agent for a child session (non-blocking) and call onComplete when done */
  startAgentForSession: (
    opts: SubagentRunOpts,
    onComplete: (result: SubagentRunResult) => void,
  ) => void;
  /** Broadcast to a specific session's WebSocket connections */
  broadcastToSession: (sessionId: string, message: unknown) => void;
}

/**
 * Create a SubagentHost from an AgentDO delegate.
 *
 * Usage in consumer's AgentDO subclass:
 * ```ts
 * const host = createSubagentHost({
 *   createSession: (opts) => this.sessionStore.create(opts),
 *   isStreaming: (sid) => this.sessionAgents.get(sid)?.state.isStreaming ?? false,
 *   steerSession: (sid, text) => this.handleSteer(sid, text, true),
 *   promptSession: (opts) => this.handleAgentPrompt(opts),
 *   abortSession: (sid) => this.sessionAgents.get(sid)?.abort(),
 *   runAgentForSession: async (opts) => { ... },
 *   startAgentForSession: (opts, onComplete) => { ... },
 *   broadcastToSession: (sid, msg) => this.broadcastToSession(sid, msg),
 * });
 * ```
 */
export function createSubagentHost(delegate: AgentDODelegate): SubagentHost {
  return {
    createSubagentSession(opts) {
      return delegate.createSession({
        name: opts.name,
        source: "subagent",
      });
    },

    async runSubagentBlocking(opts) {
      return delegate.runAgentForSession(opts);
    },

    startSubagentAsync(opts, onComplete) {
      delegate.startAgentForSession(opts, onComplete);
    },

    isSessionStreaming(sessionId) {
      return delegate.isStreaming(sessionId);
    },

    steerSession(sessionId, text) {
      delegate.steerSession(sessionId, text, true);
    },

    async promptSession(sessionId, text) {
      await delegate.promptSession({
        text,
        sessionId,
        source: "subagent-callback",
      });
    },

    async abortSession(sessionId) {
      await delegate.abortSession(sessionId);
    },

    broadcastToSession(sessionId, message) {
      delegate.broadcastToSession(sessionId, message);
    },
  };
}
