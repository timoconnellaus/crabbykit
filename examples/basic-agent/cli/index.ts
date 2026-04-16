#!/usr/bin/env bun

import * as readline from "node:readline";

// --- Colors ---
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

// --- State ---
const baseUrl =
  process.argv.find((a) => a.startsWith("--url="))?.split("=")[1] ??
  process.env.CLAW_URL ??
  "http://localhost:5173";

let agentId: string | null = null;
let sessionId: string | null = null;

// --- HTTP helpers ---
async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

function agentPath(sub: string) {
  if (!agentId) throw new Error("No agent selected. Run 'agents' then 'use <id>'.");
  return `/api/agent/${agentId}${sub}`;
}

// --- Output helpers ---
function error(msg: string) {
  console.log(`${c.red}Error: ${msg}${c.reset}`);
}

function extractText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((block) => {
        // Hide thinking blocks
        if (block.type === "thinking") return false;
        // Hide thinking JSON objects embedded in text
        if (typeof block === "string") {
          try {
            const parsed = JSON.parse(block);
            if (parsed.type === "thinking") return false;
          } catch {
            /* not JSON */
          }
        }
        return true;
      })
      .map((block) => {
        if (block.type === "text") {
          // Filter out thinking JSON embedded in text content
          try {
            const parsed = JSON.parse(block.text);
            if (parsed.type === "thinking") return null;
          } catch {
            /* not JSON, show as-is */
          }
          return block.text;
        }
        if (block.type === "toolCall")
          return `${c.dim}[tool_call: ${block.name}(${JSON.stringify(block.arguments)})]${c.reset}`;
        if (block.type === "tool_use")
          return `${c.dim}[tool_use: ${block.name}(${JSON.stringify(block.input)})]${c.reset}`;
        return JSON.stringify(block);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "string") return content;
  return JSON.stringify(content, null, 2);
}

// --- Commands ---

async function cmdAgents() {
  const agents = (await get("/api/agents")) as Array<{ id: string; name: string }>;
  if (agents.length === 0) {
    console.log(`${c.dim}No agents found. Create one with POST /api/agents.${c.reset}`);
    return;
  }
  console.log(`${c.bold}Agents:${c.reset}`);
  for (const a of agents) {
    const marker = a.id === agentId ? ` ${c.green}← active${c.reset}` : "";
    console.log(`  ${c.cyan}${a.id}${c.reset}  ${a.name}${marker}`);
  }
}

async function cmdUse(id: string) {
  agentId = id;
  sessionId = null;
  console.log(`${c.green}Agent set to ${id}${c.reset}`);
}

async function cmdSessions() {
  const data = (await get(agentPath("/debug/sessions"))) as {
    sessions: Array<{ id: string; name: string; createdAt: number }>;
  };
  if (data.sessions.length === 0) {
    console.log(`${c.dim}No sessions.${c.reset}`);
    return;
  }
  console.log(`${c.bold}Sessions:${c.reset}`);
  for (const s of data.sessions) {
    const marker = s.id === sessionId ? ` ${c.green}← active${c.reset}` : "";
    const date = s.createdAt ? new Date(s.createdAt).toLocaleString() : "";
    console.log(
      `  ${c.cyan}${s.id}${c.reset}  ${s.name || `${c.dim}(unnamed)${c.reset}`}  ${c.gray}${date}${c.reset}${marker}`,
    );
  }
}

async function cmdSession(id: string) {
  sessionId = id;
  console.log(`${c.green}Session set to ${id}${c.reset}`);
}

async function cmdMessages(limitStr?: string) {
  if (!sessionId) {
    error("No active session. Run 'sessions' then 'session <id>'.");
    return;
  }
  const limit = limitStr ? Number.parseInt(limitStr, 10) : 20;
  const data = (await get(agentPath(`/debug/messages?sessionId=${sessionId}&limit=${limit}`))) as {
    entries: Array<{
      data: {
        role: string;
        content: unknown;
        toolName?: string;
        isError?: boolean;
      };
    }>;
    hasMore: boolean;
  };

  if (data.entries.length === 0) {
    console.log(`${c.dim}No messages in this session.${c.reset}`);
    return;
  }

  for (const entry of data.entries) {
    const d = entry.data;
    if (!d?.role) continue;

    let roleColor = c.reset;
    let label = d.role;
    if (d.role === "assistant") {
      roleColor = c.cyan;
    } else if (d.role === "user") {
      roleColor = c.green;
    } else if (d.role === "toolResult") {
      roleColor = c.yellow;
      label = `tool:${d.toolName || "?"}${d.isError ? " (error)" : ""}`;
    }

    console.log(`${roleColor}${c.bold}[${label}]${c.reset}`);
    console.log(`  ${extractText(d.content).replace(/\n/g, "\n  ")}`);
  }

  if (data.hasMore) {
    console.log(`${c.dim}... more messages available (increase limit)${c.reset}`);
  }
}

async function cmdPrompt(text: string) {
  console.log(`${c.dim}Sending prompt...${c.reset}`);
  const data = (await post(agentPath("/debug/prompt"), {
    text,
    sessionId,
  })) as { sessionId: string; result?: unknown; error?: string };

  if (data.sessionId && data.sessionId !== sessionId) {
    sessionId = data.sessionId;
    console.log(`${c.dim}Session: ${sessionId}${c.reset}`);
  }

  // The prompt endpoint returns the full result from sendPrompt
  // Print it in a readable way
  if (data.error) {
    error(data.error);
  } else {
    console.log(`${c.green}Done.${c.reset} Use 'messages' to see the conversation.`);
  }
}

async function cmdTools() {
  // Hit execute-tool with a nonexistent tool name to get the list
  try {
    await post(agentPath("/debug/execute-tool"), {
      toolName: "__list__",
      args: {},
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // The 404 response contains available tools
    const match = msg.match(/\{.*\}/s);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.available) {
          console.log(`${c.bold}Available tools:${c.reset}`);
          for (const name of parsed.available) {
            console.log(`  ${c.cyan}${name}${c.reset}`);
          }
          return;
        }
      } catch {
        // fall through
      }
    }
    error(`Could not list tools: ${msg}`);
  }
}

async function cmdTool(name: string, argsStr?: string) {
  let args: Record<string, unknown> = {};
  if (argsStr) {
    try {
      args = JSON.parse(argsStr);
    } catch {
      error(`Invalid JSON args: ${argsStr}`);
      return;
    }
  }

  const res = await fetch(`${baseUrl}${agentPath("/debug/execute-tool")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, toolName: name, args }),
  });
  const data = (await res.json()) as {
    sessionId?: string;
    toolCallId?: string;
    toolName?: string;
    result?: { content: unknown[]; details: unknown };
    isError?: boolean;
    error?: string;
    issues?: string[];
    schema?: Record<string, unknown>;
  };

  if (!res.ok) {
    error(data.error ?? `${res.status}`);
    if (data.issues) {
      for (const issue of data.issues) {
        console.log(`  ${c.yellow}• ${issue}${c.reset}`);
      }
    }
    if (data.schema) {
      const props = (data.schema as { properties?: Record<string, unknown> }).properties;
      const required = (data.schema as { required?: string[] }).required;
      if (props) {
        console.log(`${c.dim}Expected parameters:${c.reset}`);
        for (const [key, val] of Object.entries(props)) {
          const req = required?.includes(key) ? " (required)" : "";
          const desc = (val as { description?: string }).description;
          const type = (val as { type?: string }).type ?? "unknown";
          console.log(`  ${c.cyan}${key}${c.reset}: ${type}${req}${desc ? ` — ${desc}` : ""}`);
        }
      }
    }
    return;
  }

  if (data.sessionId && data.sessionId !== sessionId) {
    sessionId = data.sessionId;
  }

  const resultColor = data.isError ? c.red : c.green;
  console.log(`${resultColor}${c.bold}[${data.toolName}]${c.reset}`);
  console.log(extractText(data.result?.content));
  if (data.result?.details) {
    console.log(`${c.dim}Details: ${JSON.stringify(data.result?.details, null, 2)}${c.reset}`);
  }
}

async function cmdBroadcast(event: string, dataStr?: string) {
  let data: Record<string, unknown> = {};
  if (dataStr) {
    try {
      data = JSON.parse(dataStr);
    } catch {
      error(`Invalid JSON data: ${dataStr}`);
      return;
    }
  }
  await post(agentPath("/debug/broadcast"), { event, data });
  console.log(`${c.green}Broadcast sent.${c.reset}`);
}

function cmdHelp() {
  console.log(`
${c.bold}Commands:${c.reset}
  ${c.cyan}agents${c.reset}                    List agents
  ${c.cyan}use <id>${c.reset}                  Set active agent
  ${c.cyan}sessions${c.reset}                  List sessions
  ${c.cyan}session <id>${c.reset}              Set active session
  ${c.cyan}messages [limit]${c.reset}          Show messages (default: 20)
  ${c.cyan}prompt <text>${c.reset}             Send a prompt to the agent
  ${c.cyan}tools${c.reset}                     List available tools
  ${c.cyan}tool <name> [json-args]${c.reset}   Execute a tool
  ${c.cyan}broadcast <event> [json]${c.reset}  Broadcast a custom event
  ${c.cyan}status${c.reset}                    Show current agent/session
  ${c.cyan}help${c.reset}                      Show this help
  ${c.cyan}exit${c.reset}                      Quit
`);
}

function cmdStatus() {
  console.log(`  Agent:   ${agentId ? c.cyan + agentId + c.reset : `${c.dim}(none)${c.reset}`}`);
  console.log(
    `  Session: ${sessionId ? c.cyan + sessionId + c.reset : `${c.dim}(none)${c.reset}`}`,
  );
  console.log(`  Server:  ${c.gray}${baseUrl}${c.reset}`);
}

// --- REPL ---

async function handleLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const [cmd, ...rest] = trimmed.split(/\s+/);
  const arg = rest.join(" ");

  try {
    switch (cmd) {
      case "agents":
        await cmdAgents();
        break;
      case "use":
        if (!arg) {
          error("Usage: use <agentId>");
          break;
        }
        await cmdUse(arg);
        break;
      case "sessions":
        await cmdSessions();
        break;
      case "session":
        if (!arg) {
          error("Usage: session <sessionId>");
          break;
        }
        await cmdSession(arg);
        break;
      case "messages":
      case "msgs":
        await cmdMessages(arg || undefined);
        break;
      case "prompt":
      case "p":
        if (!arg) {
          error("Usage: prompt <text>");
          break;
        }
        await cmdPrompt(arg);
        break;
      case "tools":
        await cmdTools();
        break;
      case "tool":
      case "t": {
        const parts = arg.match(/^(\S+)\s*(.*)?$/);
        if (!parts) {
          error("Usage: tool <name> [json-args]");
          break;
        }
        await cmdTool(parts[1], parts[2]?.trim() || undefined);
        break;
      }
      case "broadcast":
      case "bc": {
        const parts = arg.match(/^(\S+)\s*(.*)?$/);
        if (!parts) {
          error("Usage: broadcast <event> [json-data]");
          break;
        }
        await cmdBroadcast(parts[1], parts[2]?.trim() || undefined);
        break;
      }
      case "status":
        cmdStatus();
        break;
      case "help":
      case "?":
        cmdHelp();
        break;
      case "exit":
      case "quit":
      case "q":
        process.exit(0);
        break;
      default:
        error(`Unknown command: ${cmd}. Type 'help' for available commands.`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    error(msg);
  }
}

async function autoSelectAgent() {
  try {
    const agents = (await get("/api/agents")) as Array<{ id: string; name: string }>;
    if (agents.length === 1) {
      agentId = agents[0].id;
      console.log(
        `${c.dim}Auto-selected agent: ${c.cyan}${agents[0].name}${c.reset}${c.dim} (${agentId})${c.reset}`,
      );
    } else if (agents.length > 1) {
      console.log(`${c.bold}Available agents:${c.reset}`);
      for (let i = 0; i < agents.length; i++) {
        console.log(`  ${c.cyan}${i + 1}${c.reset}. ${agents[i].name} (${agents[i].id})`);
      }
      console.log(`${c.dim}Use 'use <id>' to select one.${c.reset}`);
    } else {
      console.log(`${c.yellow}No agents found. Is the dev server running at ${baseUrl}?${c.reset}`);
    }
  } catch {
    console.log(`${c.red}Could not connect to ${baseUrl}. Is the dev server running?${c.reset}`);
  }
}

async function main() {
  console.log(`${c.bold}claw${c.reset} ${c.dim}— debug CLI for CLAW agents${c.reset}`);
  console.log(`${c.dim}Server: ${baseUrl}${c.reset}`);
  console.log();

  await autoSelectAgent();
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.magenta}claw>${c.reset} `,
  });

  // Process lines sequentially — pause input while handling async commands
  const lineQueue: string[] = [];
  let processing = false;
  let inputClosed = false;

  async function processQueue() {
    if (processing) return;
    processing = true;
    while (lineQueue.length > 0) {
      const line = lineQueue.shift()!;
      await handleLine(line);
    }
    processing = false;
    if (inputClosed) {
      process.exit(0);
    }
    rl.prompt();
  }

  rl.on("line", (line) => {
    lineQueue.push(line);
    processQueue();
  });
  rl.on("close", () => {
    inputClosed = true;
    if (!processing) {
      console.log();
      process.exit(0);
    }
  });
}

main();
