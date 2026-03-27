/**
 * Fixture generation tests — make real OpenRouter API calls to capture response shapes.
 *
 * These tests are SKIPPED by default. To run them:
 *   GENERATE_FIXTURES=1 OPENROUTER_API_KEY=your-key bunx vitest run test/fixtures/generate-fixtures.test.ts
 *
 * Generated fixtures are saved as JSON in test/fixtures/ for use in mocked tests.
 */
import { describe, it, expect } from "vitest";
import { streamSimple, getModel } from "@mariozechner/pi-ai";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SHOULD_RUN = process.env.GENERATE_FIXTURES === "1" && process.env.OPENROUTER_API_KEY;
const FIXTURE_MODEL = process.env.FIXTURE_MODEL ?? "google/gemini-3.1-flash-lite-preview";

const describeFixtures = SHOULD_RUN ? describe : describe.skip;

describeFixtures("Fixture Generation (real AI calls)", () => {
  const model = getModel("openrouter", FIXTURE_MODEL);
  const apiKey = process.env.OPENROUTER_API_KEY!;

  it("captures text response shape", async () => {
    const events: any[] = [];

    const stream = await streamSimple(model!, {
      systemPrompt: "You are a test assistant. Reply very briefly.",
      messages: [{ role: "user", content: "Say hello in one word.", timestamp: Date.now() }],
    }, { apiKey });

    for await (const event of stream) {
      events.push({ type: event.type, partial: event.partial ? "present" : undefined });
      if (event.type === "done" || event.type === "error") break;
    }

    // Validate shape
    expect(events[0].type).toBe("start");
    expect(events[events.length - 1].type).toMatch(/^(done|error)$/);

    const types = events.map((e) => e.type);
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("text_end");

    console.log("Text response event types:", types);
  }, 30000);

  it("captures tool call response shape", async () => {
    const events: any[] = [];

    const stream = await streamSimple(model!, {
      systemPrompt: "You are a test assistant. Use the provided tool.",
      messages: [{ role: "user", content: "Search for 'test query'", timestamp: Date.now() }],
      tools: [{
        name: "web_search",
        description: "Search the web",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }],
    }, { apiKey });

    for await (const event of stream) {
      events.push({ type: event.type });
      if (event.type === "done" || event.type === "error") break;
    }

    const types = events.map((e) => e.type);
    console.log("Tool call event types:", types);

    // Should include toolcall events
    expect(types).toContain("toolcall_start");
    expect(types).toContain("toolcall_end");
  }, 30000);

  it("captures summarization response shape", async () => {
    // Build a conversation as a single user message containing the transcript
    // (streamSimple expects user/assistant alternation; passing it as context avoids format issues)
    const transcript = [
      "User: I need to set up a new API endpoint at /api/agents/:id/config that returns the agent's configuration. The agent ID is a1b2c3d4-e5f6-7890-abcd-ef1234567890.",
      "Assistant: I'll create the endpoint. The config will be served from the Durable Object at path /workspace/src/routes/api/agents/config.ts. Let me read the existing route structure first.",
      "User: The endpoint should also validate the auth token from the x-agent-id header. Use the validateConfigAuth helper from src/server/auth.ts.",
      "Assistant: Got it. I'll use validateConfigAuth for auth and return the agent config as JSON. The response should include model, tools, and capabilities sections.",
    ].join("\n\n");

    const systemPrompt = [
      "You are summarizing a conversation to maintain context while reducing token count.",
      "",
      "CRITICAL: You MUST preserve ALL opaque identifiers exactly as they appear.",
      "- UUIDs (e.g., a1b2c3d4-e5f6-7890-abcd-ef1234567890)",
      "- File paths (e.g., /workspace/src/agent/tools/file-read.ts)",
      "",
      "Focus on: active tasks, decisions made, key facts.",
      "Write the summary as a dense, factual record. Use bullet points.",
    ].join("\n");

    const events: any[] = [];
    let finalText = "";

    const stream = await streamSimple(model!, {
      systemPrompt,
      messages: [
        { role: "user" as const, content: `Please summarize this conversation:\n\n${transcript}`, timestamp: Date.now() },
      ],
    }, { apiKey });

    for await (const event of stream) {
      events.push({ type: event.type });
      if (event.type === "text_delta" && "text" in event) {
        finalText += (event as any).text;
      }
      if (event.type === "done") {
        // Extract final text from done event
        const msg = (event as any).message;
        if (msg?.content) {
          for (const block of msg.content) {
            if (block.type === "text") finalText = block.text;
          }
        }
        break;
      }
      if (event.type === "error") {
        console.error("Summarization error:", JSON.stringify(event));
        break;
      }
    }

    const types = events.map((e) => e.type);
    console.log("Summarization event types:", types);
    console.log("Summary text:", finalText);

    // Validate summarization response shape
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("text_end");
    expect(finalText.length).toBeGreaterThan(0);

    // Verify identifiers are preserved
    expect(finalText).toContain("a1b2c3d4-e5f6-7890-abcd-ef1234567890");

    // Save fixture
    const fixture = {
      model: FIXTURE_MODEL,
      generatedAt: new Date().toISOString(),
      eventTypes: types,
      summaryText: finalText,
      inputMessageCount: 1,
      validation: {
        hasUuid: finalText.includes("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
        hasFilePath: finalText.includes("/workspace/src/") || finalText.includes("src/"),
        summaryLength: finalText.length,
      },
    };

    writeFileSync(
      join(__dirname, "summarization-response.json"),
      JSON.stringify(fixture, null, 2),
    );
  }, 30000);
});

/**
 * How to regenerate fixtures:
 *
 * 1. Run: GENERATE_FIXTURES=1 OPENROUTER_API_KEY=sk-... bunx vitest run test/fixtures/generate-fixtures.test.ts
 * 2. Review the console output for event type sequences
 * 3. Update test/fixtures/agent-events.ts if the event shapes have changed
 *
 * Event format (pi-ai AssistantMessageEvent):
 * - start: { type: "start", partial: AssistantMessage }
 * - text_start/text_delta/text_end: text streaming
 * - thinking_start/thinking_delta/thinking_end: reasoning blocks
 * - toolcall_start/toolcall_delta/toolcall_end: tool call streaming
 * - done: { type: "done", reason: StopReason, message: AssistantMessage }
 * - error: { type: "error", reason: StopReason, error: AssistantMessage }
 */
