import { appRegistry, handleAppRequest } from "@claw-for-cloudflare/app-registry";
import { agentFleet } from "@claw-for-cloudflare/agent-fleet";
import { agentPeering } from "@claw-for-cloudflare/agent-peering";
import { D1AgentRegistry } from "@claw-for-cloudflare/agent-registry";
import type {
  AgentConfig,
  AgentContext,
  AgentTool,
  Capability,
  PromptOptions,
} from "@claw-for-cloudflare/agent-runtime";
import {
  AgentDO,
  createCfSqlStore,
  defineTool,
  Type,
  Value,
} from "@claw-for-cloudflare/agent-runtime";
import type { SubagentProfile } from "@claw-for-cloudflare/agent-runtime";
import { explorer } from "@claw-for-cloudflare/subagent-explorer";
import { taskTracker } from "@claw-for-cloudflare/task-tracker";
import { agentStorage } from "@claw-for-cloudflare/agent-storage";
import {
  CloudflareSandboxProvider,
  handlePreviewRequest,
  SandboxContainer,
} from "@claw-for-cloudflare/cloudflare-sandbox";
import { batchTool } from "@claw-for-cloudflare/batch-tool";
import { compactionSummary } from "@claw-for-cloudflare/compaction-summary";
import { doomLoopDetection } from "@claw-for-cloudflare/doom-loop-detection";
import { toolOutputTruncation } from "@claw-for-cloudflare/tool-output-truncation";
import { credentialStore } from "@claw-for-cloudflare/credential-store";
import { heartbeat } from "@claw-for-cloudflare/heartbeat";
import { promptScheduler } from "@claw-for-cloudflare/prompt-scheduler";
import { r2Storage } from "@claw-for-cloudflare/r2-storage";
import { sandboxCapability } from "@claw-for-cloudflare/sandbox";
import { tavilyWebSearch } from "@claw-for-cloudflare/tavily-web-search";
import { vectorMemory } from "@claw-for-cloudflare/vector-memory";
import { aiProxy, AiService } from "@claw-for-cloudflare/ai-proxy";
import type { SkillSeed } from "@claw-for-cloudflare/skill-registry";
import { D1SkillRegistry } from "@claw-for-cloudflare/skill-registry";
import { skills } from "@claw-for-cloudflare/skills";
import {
  BackendStorage,
  DbService,
  handleDeployRequest,
  vibeCoder,
} from "@claw-for-cloudflare/vibe-coder";
import { debugInspector } from "./debug-capability";

interface Env {
  AGENT: DurableObjectNamespace;
  SANDBOX_CONTAINER: DurableObjectNamespace;
  BACKEND_STORAGE: DurableObjectNamespace;
  DB_SERVICE: Service<DbService>;
  AI_SERVICE: Service<AiService>;
  STORAGE_BUCKET: R2Bucket;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  LOADER: WorkerLoader;
  OPENROUTER_API_KEY: string;
  TAVILY_API_KEY: string;
  // R2 credentials for container FUSE mount (set via wrangler secret put)
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  // Agent-ops (set via wrangler secret put)
  AGENT_SECRET: string;
  AGENT_DB: D1Database;
  SKILL_DB: D1Database;
}

const VIBE_WEBAPP_SKILL_MD = `---
name: vibe-webapp
description: Fullstack Bun web app development with database, styling, live preview, and deployment
---

# Vibe Webapp Development

Build fullstack web apps using Bun inside the sandbox container. Apps run on Bun.serve() with React frontends, persistent databases via container-db, and Tailwind styling.

## Project Structure

Create apps on \`/mnt/r2/\` so files persist. Typical layout:

\`\`\`
/mnt/r2/my-app/
  package.json
  bunfig.toml        # (optional, for Tailwind plugin)
  server.ts          # Bun.serve() entry point
  index.html         # HTML entry with React mount
  app.tsx            # React frontend
  styles.css         # (optional) CSS/Tailwind
\`\`\`

## Server Pattern (server.ts)

Use Bun.serve() with HTML imports and route-based API handlers.

**IMPORTANT: \`@claw-for-cloudflare/container-db\` is pre-installed in the container via a Bun plugin. Do NOT add it to package.json — it is not on npm and will cause \`bun install\` to fail with a 404. Just import it directly in your code.**

\`\`\`typescript
import { createDB } from "@claw-for-cloudflare/container-db";
import homepage from "./index.html";

const db = createDB();

// Initialize schema
await db.exec(\\\`CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)\\\`);

Bun.serve({
  hostname: "0.0.0.0",
  port: 3000,
  routes: {
    "/": homepage,
    "/api/items": {
      async GET() {
        const { rows, columns } = await db.exec("SELECT * FROM items ORDER BY id DESC");
        const items = rows.map(row =>
          Object.fromEntries(columns.map((col, i) => [col, row[i]]))
        );
        return Response.json(items);
      },
      async POST(req) {
        const { name } = await req.json();
        await db.exec("INSERT INTO items (name) VALUES (?)", [name]);
        return Response.json({ ok: true });
      },
    },
  },
  development: true,
});
\`\`\`

## HTML Entry (index.html)

\`\`\`html
<!DOCTYPE html>
<html>
<head>
  <title>My App</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./app.tsx"></script>
</body>
</html>
\`\`\`

## React Frontend (app.tsx)

\`\`\`tsx
import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";

function App() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    fetch("/api/items").then(r => r.json()).then(setItems);
  }, []);

  return (
    <div>
      <h1>Items</h1>
      <ul>{items.map(item => <li key={item.id}>{item.name}</li>)}</ul>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
\`\`\`

## Database (container-db)

Use \`@claw-for-cloudflare/container-db\` for database access. It works identically in dev (container) and deploy (worker). It is pre-installed — do NOT add it to package.json.

\`\`\`typescript
import { createDB } from "@claw-for-cloudflare/container-db";
const db = createDB();

// Query returns { columns: string[], rows: unknown[][] }
const { columns, rows } = await db.exec("SELECT * FROM users WHERE active = ?", [true]);

// Batch multiple statements
await db.batch([
  { sql: "INSERT INTO items (name) VALUES (?)", params: ["A"] },
  { sql: "INSERT INTO items (name) VALUES (?)", params: ["B"] },
]);
\`\`\`

Always use parameterized queries (\`?\` placeholders) — never interpolate values into SQL strings.

\`@claw-for-cloudflare/container-db\` is pre-installed in the container — no need to add it to package.json or run bun install for it.

## AI Access

Apps can call AI models via the OpenAI SDK using the \`ai.internal\` virtual host:

\`\`\`typescript
import OpenAI from "openai";
const ai = new OpenAI({
  baseURL: "http://ai.internal/v1",
  apiKey: "internal",
});

const response = await ai.chat.completions.create({
  model: "anthropic/claude-sonnet-4",
  messages: [{ role: "user", content: "Hello" }],
});
\`\`\`

Both streaming and non-streaming are supported. Costs are tracked automatically.

## Styling with Tailwind

Install the Bun Tailwind plugin:

\`\`\`bash
bun add bun-plugin-tailwind
\`\`\`

Create bunfig.toml:

\`\`\`toml
[serve.static]
plugins = ["bun-plugin-tailwind"]
\`\`\`

Then use Tailwind classes in your components and import the CSS file in index.html.

## Dev Workflow

1. Create the project directory on /mnt/r2/
2. Write all source files
3. \`cd /mnt/r2/my-app && bun install\`
4. Start the server: \`exec\` with \`background=true\`: \`cd /mnt/r2/my-app && bun run server.ts\`
5. Call \`show_preview\` with the server port (default 3000)
6. Iterate: edit files, the server auto-reloads with HMR
7. Use \`get_console_logs\` to check for frontend errors
8. Call \`hide_preview\` when done

When making changes after the server is running, just edit the files — Bun's dev mode handles HMR.
If the server crashes, restart it with exec.

## Deployment

Build and deploy using the deploy_app tool:

1. Build: \`bun build --target=bun --production --outdir=dist server.ts\`
2. Deploy with \`deploy_app\`:
   - \`entryPoint\`: path to the built server entry
   - \`name\`: app slug for the URL

Deployed apps are accessible at \`/apps/{slug}/\`.

For apps with backends, use \`start_backend\` first to bundle and load the backend worker.

## Common Mistakes

- **Not binding to 0.0.0.0**: The server MUST use \`hostname: "0.0.0.0"\` — localhost won't be reachable from outside the container
- **Using bun:sqlite instead of container-db**: Always use \`@claw-for-cloudflare/container-db\` — bun:sqlite data doesn't persist across deploys
- **Absolute fetch paths**: Frontend fetch calls must use relative paths (\`fetch("/api/items")\`), not absolute URLs
- **Missing development: true**: Without \`development: true\` in Bun.serve(), HMR and console output won't work
- **Forgetting to restart after changes**: If you change server.ts structure (new routes, etc.), restart the server process
- **Trying to install container-db**: \`@claw-for-cloudflare/container-db\` is pre-installed in the container via a Bun plugin — do NOT add it to package.json (it will 404 from npm)
`;

const EXAMPLE_SKILL_SEEDS: SkillSeed[] = [
  {
    id: "vibe-webapp",
    name: "Vibe Webapp",
    description:
      "Fullstack Bun web app development with database via container-db, React frontend, Tailwind styling, live preview, and deployment. Load when building web apps in the sandbox.",
    version: "1.1.0",
    requiresCapabilities: ["vibe-coder", "sandbox"],
    skillMd: VIBE_WEBAPP_SKILL_MD,
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "Reviews code changes for bugs, security issues, and style violations",
    version: "1.0.0",
    requiresCapabilities: [],
    skillMd: `---
name: code-review
description: Reviews code changes for bugs, security issues, and style violations
---

# Code Review

When reviewing code, follow this checklist:

## Security
- Check for injection vulnerabilities (SQL, XSS, command injection)
- Verify authentication and authorization checks
- Look for hardcoded secrets or credentials

## Correctness
- Verify error handling covers edge cases
- Check for off-by-one errors and boundary conditions
- Ensure async operations are properly awaited

## Style
- Consistent naming conventions
- No unnecessary complexity
- Functions are focused and reasonably sized
`,
  },
  {
    id: "debug-systematic",
    name: "Systematic Debugging",
    description: "Step-by-step approach to isolating and fixing bugs",
    version: "1.0.0",
    requiresCapabilities: [],
    skillMd: `---
name: debug-systematic
description: Step-by-step approach to isolating and fixing bugs
---

# Systematic Debugging

When debugging an issue, follow this process:

## 1. Reproduce
- Get a minimal reproduction case
- Document the expected vs actual behavior
- Note the environment (OS, runtime, versions)

## 2. Isolate
- Binary search: disable half the code, narrow the scope
- Check recent changes (git log, git bisect)
- Add logging at key boundaries

## 3. Hypothesize and Test
- Form a specific hypothesis about the cause
- Design a test that would confirm or refute it
- Run the test before making changes

## 4. Fix and Verify
- Make the smallest change that fixes the issue
- Verify the original reproduction case passes
- Check for regressions in related functionality
`,
  },
];

/**
 * A minimal agent that can tell the time and do basic math.
 * Demonstrates extending AgentDO with custom tools.
 */
export class BasicAgent extends AgentDO<Env> {
  getConfig(): AgentConfig {
    return {
      provider: "openrouter",
      modelId: "minimax/minimax-m2.7",
      apiKey: this.env.OPENROUTER_API_KEY,
      a2a: { discoverable: true },
    };
  }

  protected getCapabilities(): Capability[] {
    const storage = agentStorage({
      bucket: () => this.env.STORAGE_BUCKET,
      namespace: this.ctx.id.toString(),
    });

    // Share a single sandbox provider across capabilities so env var
    // injection (e.g. AI proxy token) reaches the same container.
    const sandboxProvider = new CloudflareSandboxProvider({
      storage,
      getStub: () => {
        const id = this.env.SANDBOX_CONTAINER.idFromName(this.ctx.id.toString());
        return this.env.SANDBOX_CONTAINER.get(id);
      },
      containerMode: "dev",
    });

    return [
      compactionSummary({
        provider: "openrouter",
        modelId: "google/gemini-2.0-flash-001",
        getApiKey: () => this.env.OPENROUTER_API_KEY,
        pruneBudget: 40_000,
      }),
      tavilyWebSearch({
        tavilyApiKey: () => this.env.TAVILY_API_KEY,
      }),
      r2Storage({ storage }),
      vectorMemory({
        storage,
        vectorizeIndex: () => this.env.MEMORY_INDEX,
        ai: () => this.env.AI,
      }),
      promptScheduler(),
      credentialStore(),
      heartbeat({ every: "30m", enabled: false }),
      ...this.buildAgentOpsCapabilities(),
      sandboxCapability({ provider: sandboxProvider }),
      doomLoopDetection(),
      toolOutputTruncation(),
      batchTool({
        getTools: () => this.resolveToolsForSession(this.sessionStore.list()[0]?.id ?? "").tools,
      }),
      taskTracker({ sql: createCfSqlStore(this.ctx.storage.sql) }),
      debugInspector(),
      vibeCoder({
        provider: sandboxProvider,
        backend: {
          loader: this.env.LOADER,
          dbService: this.env.DB_SERVICE,
          aiService: this.env.AI_SERVICE,
        },
      }),
      appRegistry({
        provider: sandboxProvider,
        sql: createCfSqlStore(this.ctx.storage.sql),
        storage,
        backend: {
          loader: this.env.LOADER,
          dbService: this.env.DB_SERVICE,
        },
      }),
      aiProxy({
        apiKey: () => this.env.OPENROUTER_API_KEY,
      }),
      skills({
        storage,
        registry: new D1SkillRegistry(this.env.SKILL_DB, {
          seeds: EXAMPLE_SKILL_SEEDS,
        }),
        skills: [
          { id: "vibe-webapp", enabled: true, autoUpdate: true },
          { id: "code-review", enabled: true, autoUpdate: true },
        ],
      }),
    ];
  }

  private buildAgentOpsCapabilities(): Capability[] {
    const agentId = this.ctx.id.toString();
    const getAgentStub = (id: string) => this.env.AGENT.get(this.env.AGENT.idFromName(id));
    // resolveDoId converts registry UUIDs to DO hex IDs for HMAC token signing,
    // ensuring the token target matches the receiving DO's this.ctx.id.toString().
    const resolveDoId = (id: string) => this.env.AGENT.idFromName(id).toString();
    const registry = new D1AgentRegistry(this.env.AGENT_DB);

    const peering = agentPeering({
      secret: this.env.AGENT_SECRET,
      getAgentStub,
      resolveDoId,
      agentId,
    });

    return [
      peering.capability,
      agentFleet({
        registry,
        secret: this.env.AGENT_SECRET,
        getAgentStub,
        resolveDoId,
        agentId,
        ownerId: "default",
      }),
    ];
  }

  // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance requires explicit any
  getTools(_context: AgentContext): AgentTool<any>[] {
    return [
      defineTool({
        name: "get_current_time",
        description: "Get the current date and time in ISO format.",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text" as const, text: new Date().toISOString() }],
          details: null,
        }),
      }),
      defineTool({
        name: "calculate",
        description: "Evaluate a math expression.",
        parameters: Type.Object({
          expression: Type.String({ description: "The math expression to evaluate" }),
        }),
        execute: async ({ expression }) => {
          try {
            const result = Function(`"use strict"; return (${expression})`)();
            return {
              content: [{ type: "text" as const, text: String(result) }],
              details: { expression, result },
            };
          } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            return {
              content: [{ type: "text" as const, text: `Error: ${errorMessage}` }],
              details: { expression, error: errorMessage },
            };
          }
        },
      }),
    ];
  }

  protected getA2AClientOptions() {
    return {
      getAgentStub: (id: string) => {
        // Support both DO names ("bob") and hex IDs ("fcc50dec...")
        const doId = /^[0-9a-f]{64}$/i.test(id)
          ? this.env.AGENT.idFromString(id)
          : this.env.AGENT.idFromName(id);
        return this.env.AGENT.get(doId);
      },
      resolveDoId: (id: string) => this.env.AGENT.idFromName(id).toString(),
      callbackBaseUrl: "https://agent",
    };
  }

  protected getSubagentProfiles(): SubagentProfile[] {
    return [explorer({ model: "google/gemini-2.5-flash" })];
  }

  protected getPromptOptions(): PromptOptions {
    return {
      agentName: "Basic Agent",
      agentDescription: "A helpful agent that can search, compute, and manage files.",
      timezone: "UTC",
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/debug/execute-tool") {
      return this.handleDebugToolExecution(request);
    }
    return super.fetch(request);
  }

  private async handleDebugToolExecution(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      sessionId?: string;
      toolName: string;
      args?: Record<string, unknown>;
    };

    const { toolName, args = {} } = body;
    const sessionId =
      body.sessionId ?? this.sessionStore.list()[0]?.id ?? this.sessionStore.create().id;

    // Resolve all tools (base + capabilities) using proper context
    const { tools: allTools } = this.resolveToolsForSession(sessionId);

    const tool = allTools.find((t) => t.name === toolName);
    if (!tool) {
      const available = allTools.map((t) => t.name);
      return Response.json({ error: `Tool "${toolName}" not found`, available }, { status: 404 });
    }

    // Validate args against the tool's TypeBox schema
    if (tool.parameters) {
      const errors = [...Value.Errors(tool.parameters, args)];
      if (errors.length > 0) {
        const issues = errors.map((e) => `${e.path || "/"}: ${e.message}`);
        return Response.json(
          {
            error: "Invalid tool arguments",
            issues,
            schema: tool.parameters,
          },
          { status: 400 },
        );
      }
    }

    const toolCallId = crypto.randomUUID();

    // Persist assistant message with tool_use block
    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
        timestamp: Date.now(),
      },
    });

    // Broadcast tool_execution_start
    this.transport.broadcastToSession(sessionId, {
      type: "tool_event",
      sessionId,
      event: { type: "tool_execution_start", toolCallId, toolName, args },
    });

    // Execute the tool
    let result: { content: unknown[]; details: unknown };
    let isError = false;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: tool.execute args type varies per tool
      result = await (tool as AgentTool<any>).execute(args, {
        toolCallId,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e: unknown) {
      isError = true;
      const message = e instanceof Error ? e.message : String(e);
      result = {
        content: [{ type: "text", text: `Error: ${message}` }],
        details: { error: message },
      };
    }

    // Persist tool result
    this.sessionStore.appendEntry(sessionId, {
      type: "message",
      data: {
        role: "toolResult",
        content: result.content,
        details: result.details ?? null,
        toolCallId,
        toolName,
        isError,
        timestamp: Date.now(),
      },
    });

    // Broadcast tool_execution_end
    this.transport.broadcastToSession(sessionId, {
      type: "tool_event",
      sessionId,
      event: { type: "tool_execution_end", toolCallId, toolName, result, isError },
    });

    return Response.json({ sessionId, toolCallId, toolName, result, isError });
  }
}

// Re-export DOs and entrypoints for wrangler to bind
export { AiService, BackendStorage, DbService, SandboxContainer };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const jsonHeaders = { "content-type": "application/json" };

    // GET /agents — list all agents from registry
    if (url.pathname === "/agents" && request.method === "GET") {
      const registry = new D1AgentRegistry(env.AGENT_DB);
      const agents = await registry.list("default");
      return new Response(JSON.stringify(agents), { headers: jsonHeaders });
    }

    // POST /agents — create a new root agent
    if (url.pathname === "/agents" && request.method === "POST") {
      const body = (await request.json()) as { name: string };
      const registry = new D1AgentRegistry(env.AGENT_DB);
      const agent = await registry.create({
        id: crypto.randomUUID(),
        name: body.name,
        ownerId: "default",
        parentAgentId: null,
      });
      return new Response(JSON.stringify(agent), { headers: jsonHeaders, status: 201 });
    }

    // /deploy/:agentId/:deployId[/...] — serve deployed apps via worker loader (legacy)
    const deployRes = handleDeployRequest({
      request,
      agentNamespace: env.AGENT,
      storageBucket: env.STORAGE_BUCKET,
      loader: env.LOADER,
      dbService: env.DB_SERVICE,
      aiService: env.AI_SERVICE,
    });
    if (deployRes) return deployRes;

    // /apps/:slug[/...] — serve named apps via app-registry
    const appRes = handleAppRequest({
      request,
      agentNamespace: env.AGENT,
      storageBucket: env.STORAGE_BUCKET,
      loader: env.LOADER,
      dbService: env.DB_SERVICE,
    });
    if (appRes) return appRes;

    // /preview/:id[/...] — proxy to sandbox container for dev server preview
    // With Bun fullstack, the container handles both HTML and API routes
    const previewRes = handlePreviewRequest({
      request,
      agentNamespace: env.AGENT,
      containerNamespace: env.SANDBOX_CONTAINER,
    });
    if (previewRes) return previewRes;

    // /agent/:agentId[/...] — route to agent DO by ID
    const agentMatch = url.pathname.match(/^\/agent\/([^/]+)(\/.*)?$/);
    if (agentMatch) {
      const agentId = agentMatch[1];
      const id = env.AGENT.idFromName(agentId);
      const stub = env.AGENT.get(id);
      // Strip the /agent/:agentId prefix so the DO sees clean paths
      const doUrl = new URL(request.url);
      doUrl.pathname = agentMatch[2] || "/";
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    return new Response("Basic Agent Example", { status: 200 });
  },
};
