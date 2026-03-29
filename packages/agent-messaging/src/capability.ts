import type { Capability, CapabilityStorage } from "@claw-for-cloudflare/agent-runtime";
import { createMessagingHandlers } from "./handlers.js";
import { createAgentMessageTool } from "./tools.js";
import type { MessagingOptions } from "./types.js";

/**
 * Create the agent-messaging capability.
 *
 * Provides inter-agent message passing — both sync and async.
 *
 * Storage is lazily resolved — it becomes available when the capability's
 * `httpHandlers()`, `tools()`, or `promptSections()` is first called by the framework.
 */
export function agentMessaging(options: MessagingOptions): Capability {
  let _storage: CapabilityStorage | undefined;

  const getStorage = (): CapabilityStorage => {
    if (!_storage) {
      throw new Error("Messaging not initialized — capability must be registered");
    }
    return _storage;
  };

  return {
    id: "agent-messaging",
    name: "Agent Messaging",
    description: "Send and receive messages between agents.",

    tools: (context) => {
      _storage = context.storage;
      return [createAgentMessageTool(options, getStorage)];
    },

    httpHandlers: (context) => {
      _storage = context.storage;
      return createMessagingHandlers(options, getStorage);
    },

    promptSections: (context) => {
      _storage = context.storage;
      return [
        "You can send messages to other agents using the agent_message tool. " +
          'Use mode "sync" (default) for request-response conversations, or ' +
          '"async" for fire-and-forget messages where the reply arrives later as a notification.',
      ];
    },
  };
}
