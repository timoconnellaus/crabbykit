import { useCallback } from "react";
import type { PromptSection } from "../../prompt/types.js";
import { useAgentConnection } from "../agent-connection-provider.js";

export interface UseSystemPromptReturn {
  systemPrompt: { sections: PromptSection[]; raw: string } | null;
  requestSystemPrompt: () => void;
}

/**
 * Exposes the current system prompt snapshot and a function to request a
 * fresh copy from the server.
 */
export function useSystemPrompt(): UseSystemPromptReturn {
  const { send, state } = useAgentConnection();

  const requestSystemPrompt = useCallback(() => {
    send({ type: "request_system_prompt" });
  }, [send]);

  return {
    systemPrompt: state.systemPrompt,
    requestSystemPrompt,
  };
}
