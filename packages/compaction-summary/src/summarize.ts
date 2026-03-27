import type { AgentMessage } from "@claw-for-cloudflare/agent-core";
import type { SummarizeFn } from "@claw-for-cloudflare/agent-runtime";
import { buildSummarizationPrompt } from "@claw-for-cloudflare/agent-runtime";

// Lazy-load pi-ai to avoid CJS issues in Workers test pool
// biome-ignore lint/suspicious/noExplicitAny: pi-ai module is dynamically imported; no static types available
let _streamSimple: any;
// biome-ignore lint/suspicious/noExplicitAny: pi-ai module is dynamically imported; no static types available
let _getModel: any;
async function loadPiAi() {
  if (!_streamSimple) {
    const ai = await import("@claw-for-cloudflare/ai");
    _streamSimple = ai.streamSimple;
    _getModel = ai.getModel;
  }
  return { streamSimple: _streamSimple, getModel: _getModel };
}

/**
 * Convert an array of AgentMessages to a readable text transcript.
 */
function messagesToText(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      // biome-ignore lint/suspicious/noExplicitAny: AgentMessage role/content types are opaque from pi-agent-core
      const role = ((m as any).role ?? "unknown").toUpperCase();
      // biome-ignore lint/suspicious/noExplicitAny: AgentMessage content type is opaque from pi-agent-core
      const content = (m as any).content;
      let text: string;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          // biome-ignore lint/suspicious/noExplicitAny: content blocks from pi-agent-core have no exported type
          .filter((b: any) => typeof b === "string" || b?.type === "text")
          // biome-ignore lint/suspicious/noExplicitAny: content blocks from pi-agent-core have no exported type
          .map((b: any) => (typeof b === "string" ? b : b.text))
          .join(" ");
      } else {
        text = JSON.stringify(content);
      }
      return `${role}: ${text}`;
    })
    .join("\n");
}

/**
 * Extract the final text from a streamSimple stream.
 * Iterates events until "done", then extracts text content blocks from the message.
 */
// biome-ignore lint/suspicious/noExplicitAny: pi-ai stream events have no exported type
async function collectStreamText(stream: AsyncIterable<any>): Promise<string> {
  let finalText = "";
  for await (const event of stream) {
    if (event.type === "done") {
      const msg = event.message;
      if (msg?.content) {
        finalText = msg.content
          // biome-ignore lint/suspicious/noExplicitAny: pi-ai stream message content blocks have no exported type
          .filter((b: any) => b.type === "text")
          // biome-ignore lint/suspicious/noExplicitAny: pi-ai stream message content blocks have no exported type
          .map((b: any) => b.text)
          .join("\n");
      }
      break;
    }
    if (event.type === "error") {
      const errorMsg = event.error?.message ?? event.message ?? "Summarization failed";
      throw new Error(`Summarization error: ${errorMsg}`);
    }
  }
  return finalText || "No summary generated.";
}

/**
 * Create a SummarizeFn backed by a real LLM call via pi-ai's streamSimple.
 */
export function createLlmSummarizer(
  provider: string,
  modelId: string,
  getApiKey: () => string,
): SummarizeFn {
  return async (
    messages: AgentMessage[],
    previousSummary?: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    const { streamSimple, getModel } = await loadPiAi();
    const model = getModel(provider, modelId);

    if (!model) {
      throw new Error(`Summarization model not found: ${provider}/${modelId}`);
    }

    const conversationText = messagesToText(messages);
    const systemPrompt = buildSummarizationPrompt(previousSummary);

    const stream = await streamSimple(
      model,
      {
        systemPrompt,
        messages: [
          {
            role: "user" as const,
            content: `Please summarize this conversation:\n\n${conversationText}`,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: getApiKey(), signal },
    );

    return collectStreamText(stream);
  };
}

// Exported for testing
export { collectStreamText, messagesToText };
