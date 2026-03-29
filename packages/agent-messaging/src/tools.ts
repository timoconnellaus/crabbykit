import { setAuthHeaders, signToken } from "@claw-for-cloudflare/agent-auth";
import type { AgentTool } from "@claw-for-cloudflare/agent-runtime";
import { type CapabilityStorage, defineTool, Type } from "@claw-for-cloudflare/agent-runtime";
import type { MessagingOptions } from "./types.js";

/**
 * Create the agent_message tool for sending messages to other agents.
 */
export function createAgentMessageTool(
  options: MessagingOptions,
  getStorage: () => CapabilityStorage,
): AgentTool {
  return defineTool({
    name: "agent_message",
    description:
      "Send a message to another agent. In sync mode, waits for and returns the response. In async mode, returns a messageId and the reply arrives later.",
    parameters: Type.Object({
      targetAgentId: Type.String({ description: "ID of the agent to message" }),
      message: Type.String({ description: "The message to send" }),
      mode: Type.Optional(
        Type.Union([Type.Literal("sync"), Type.Literal("async")], {
          description:
            'Message mode: "sync" (wait for response) or "async" (fire-and-forget). Default "sync".',
        }),
      ),
    }),
    execute: async ({ targetAgentId, message, mode }) => {
      const effectiveMode = mode ?? "sync";
      const storage = getStorage();

      // Read current depth (set by incoming message handler, or 0 for top-level)
      const currentDepth = (await storage.get<number>("depth")) ?? 0;

      const resolveDoId = options.resolveDoId ?? ((x: string) => x);
      const token = await signToken(options.agentId, resolveDoId(targetAgentId), options.secret);
      const stub = options.getAgentStub(targetAgentId);
      const headers = new Headers({ "Content-Type": "application/json" });
      setAuthHeaders(headers, token, options.agentId);

      if (effectiveMode === "sync") {
        const response = await stub.fetch("https://agent/agent-message-sync", {
          method: "POST",
          headers,
          body: JSON.stringify({
            message,
            senderName: options.agentName ?? options.agentId,
            depth: currentDepth + 1,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          return {
            content: [
              {
                type: "text" as const,
                text: `Error from agent ${targetAgentId}: ${response.status} — ${errorText}`,
              },
            ],
            details: { error: "agent_error", status: response.status },
          };
        }

        const result = (await response.json()) as {
          ok: boolean;
          response: string;
          sessionId: string;
        };
        return {
          content: [{ type: "text" as const, text: result.response }],
          details: { targetAgentId, sessionId: result.sessionId, mode: "sync" },
        };
      }

      // Async mode
      const response = await stub.fetch("https://agent/agent-message", {
        method: "POST",
        headers,
        body: JSON.stringify({
          message,
          senderName: options.agentName ?? options.agentId,
          depth: currentDepth + 1,
          replyTo: options.agentId,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        return {
          content: [
            {
              type: "text" as const,
              text: `Error from agent ${targetAgentId}: ${response.status} — ${errorText}`,
            },
          ],
          details: { error: "agent_error", status: response.status },
        };
      }

      const result = (await response.json()) as { ok: boolean; messageId: string };
      return {
        content: [
          {
            type: "text" as const,
            text: `Message sent to agent ${targetAgentId}. The response will arrive asynchronously (messageId: ${result.messageId}).`,
          },
        ],
        details: { targetAgentId, messageId: result.messageId, mode: "async" },
      };
    },
  }) as unknown as AgentTool;
}
