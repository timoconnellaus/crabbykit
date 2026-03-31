import type { Capability } from "@claw-for-cloudflare/agent-runtime";

/**
 * Debug/inspection capability for the example app.
 * Registers HTTP endpoints for listing sessions, reading messages,
 * sending prompts, and broadcasting events.
 */
export function debugInspector(): Capability {
  return {
    id: "debug-inspector",
    name: "Debug Inspector",
    description: "HTTP endpoints for inspecting and controlling the agent.",

    httpHandlers: () => [
      {
        method: "GET" as const,
        path: "/debug/sessions",
        handler: async (_req, ctx) => {
          const sessions = ctx.sessionStore.list();
          return Response.json({ sessions });
        },
      },
      {
        method: "GET" as const,
        path: "/debug/messages",
        handler: async (req, ctx) => {
          const url = new URL(req.url);
          const sessionId = url.searchParams.get("sessionId");
          if (!sessionId) {
            return Response.json({ error: "sessionId query param is required" }, { status: 400 });
          }
          const limit = Number(url.searchParams.get("limit") ?? "50");
          const afterSeq = url.searchParams.get("afterSeq")
            ? Number(url.searchParams.get("afterSeq"))
            : undefined;
          const { entries, hasMore } = ctx.sessionStore.getEntriesPaginated(sessionId, {
            limit,
            afterSeq,
          });
          return Response.json({
            sessionId,
            entries,
            hasMore,
            cursor: entries.length ? entries[entries.length - 1].seq : null,
          });
        },
      },
      {
        method: "POST" as const,
        path: "/debug/prompt",
        handler: async (req, ctx) => {
          const body = (await req.json()) as { text: string; sessionId?: string };
          const result = await ctx.sendPrompt({
            text: body.text,
            sessionId: body.sessionId,
            source: "debug-api",
          });
          return Response.json(result);
        },
      },
      {
        method: "POST" as const,
        path: "/debug/broadcast",
        handler: async (req, ctx) => {
          const body = (await req.json()) as { event: string; data: Record<string, unknown> };
          ctx.broadcastToAll(body.event, body.data);
          return Response.json({ sent: true });
        },
      },
    ],
  };
}
