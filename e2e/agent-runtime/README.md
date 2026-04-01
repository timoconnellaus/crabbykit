# E2E: Agent Runtime

End-to-end tests for the CLAW agent runtime. Tests the full stack — AgentDO, session management, capabilities, tool execution, hooks, and the `useAgentChat` client hook — without requiring real LLM API calls.

## Approach

- **Inject, don't infer.** Tests inject tool calls and agent responses via the debug API rather than hitting a live LLM. This makes tests deterministic and fast.
- **Real runtime, real DOs.** Tests run against an actual Cloudflare Workers + Durable Objects environment (via `@cloudflare/vitest-pool-workers` or a local dev server), not mocks.
- **Hooks under test.** `useAgentChat` and the WebSocket transport are first-class test subjects. We verify that client state updates correctly in response to injected server-side events.
- **No UI rendering.** We test the hooks directly (React hook testing), not a rendered frontend.

## What We Test

- Session lifecycle (create, switch, branch, list)
- Tool execution via debug API (inject tool calls, verify results and side effects)
- Capability registration and tool availability
- Transport protocol (WebSocket message flow, reconnection)
- `useAgentChat` hook state transitions (messages, streaming state, session switching)
- Prompt injection via debug API and resulting session entries
- Cost event emission and client receipt
- Schedule creation/update/deletion via capability tools
- Compaction triggers and context rebuilding
- Hook execution order (`beforeInference`, `onTurnEnd`, etc.)

## Status

Scaffolding only. Test implementation is next.
