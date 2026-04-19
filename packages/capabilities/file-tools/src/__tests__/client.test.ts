/**
 * fileToolsClient unit tests (task 4.12).
 *
 * Verifies:
 *  - capability id matches the scope string "file-tools"
 *  - all nine tool names are registered
 *  - missing __BUNDLE_TOKEN throws on every tool
 *  - capability has NO host-only surfaces (hooks, httpHandlers,
 *    configNamespaces, onAction, promptSections)
 *  - tools forward `(token, args, SCHEMA_CONTENT_HASH)` to the mock service
 */

import type { AgentTool } from "@crabbykit/agent-core";
import type { AgentContext } from "@crabbykit/agent-runtime";
import { createNoopStorage } from "@crabbykit/agent-runtime";
import { textOf } from "@crabbykit/agent-runtime/test-utils";
import { describe, expect, it, vi } from "vitest";
import { fileToolsClient } from "../client.js";
import {
  FILE_COPY_TOOL_NAME,
  FILE_DELETE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_FIND_TOOL_NAME,
  FILE_LIST_TOOL_NAME,
  FILE_MOVE_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_TREE_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  SCHEMA_CONTENT_HASH,
} from "../schemas.js";
import type { FileToolsService } from "../service.js";

type MockService = Service<FileToolsService> & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  copy: ReturnType<typeof vi.fn>;
  move: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  tree: ReturnType<typeof vi.fn>;
  find: ReturnType<typeof vi.fn>;
};

function makeMockService(): MockService {
  const ok = (text: string) => ({ text, details: { ok: true } });
  return {
    read: vi.fn(async () => ok("read-result")),
    write: vi.fn(async () => ok("write-result")),
    edit: vi.fn(async () => ok("edit-result")),
    delete: vi.fn(async () => ok("delete-result")),
    copy: vi.fn(async () => ok("copy-result")),
    move: vi.fn(async () => ok("move-result")),
    list: vi.fn(async () => ok("list-result")),
    tree: vi.fn(async () => ok("tree-result")),
    find: vi.fn(async () => ok("find-result")),
  } as unknown as MockService;
}

function makeContext(token?: string): AgentContext & {
  env: { __BUNDLE_TOKEN?: string };
} {
  return {
    agentId: "agent",
    sessionId: "session",
    stepNumber: 0,
    emitCost: vi.fn(),
    broadcast: () => {},
    broadcastToAll: () => {},
    broadcastState: () => {},
    requestFromClient: () => Promise.reject(new Error("Not available")),
    storage: createNoopStorage(),
    schedules: {} as never,
    rateLimit: { consume: async () => ({ allowed: true }) },
    env: { __BUNDLE_TOKEN: token },
  } as unknown as AgentContext & { env: { __BUNDLE_TOKEN?: string } };
}

// biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
function toolByName(tools: AgentTool<any>[], name: string): AgentTool<any> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

const ALL_TOOL_NAMES = [
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_DELETE_TOOL_NAME,
  FILE_COPY_TOOL_NAME,
  FILE_MOVE_TOOL_NAME,
  FILE_LIST_TOOL_NAME,
  FILE_TREE_TOOL_NAME,
  FILE_FIND_TOOL_NAME,
] as const;

// ---------------------------------------------------------------------------
// Capability shape
// ---------------------------------------------------------------------------

describe("fileToolsClient capability shape", () => {
  it("has id 'file-tools' matching the catalog scope string", () => {
    const cap = fileToolsClient({ service: makeMockService() });
    expect(cap.id).toBe("file-tools");
  });

  it("registers NO lifecycle hooks (Phase 0 bridge fires static cap's hook)", () => {
    const cap = fileToolsClient({ service: makeMockService() });
    expect(cap.hooks).toBeUndefined();
  });

  it("registers no httpHandlers", () => {
    const cap = fileToolsClient({ service: makeMockService() });
    expect(cap.httpHandlers).toBeUndefined();
  });

  it("registers no configNamespaces", () => {
    const cap = fileToolsClient({ service: makeMockService() });
    expect(cap.configNamespaces).toBeUndefined();
  });

  it("registers no onAction handler", () => {
    const cap = fileToolsClient({ service: makeMockService() });
    expect(cap.onAction).toBeUndefined();
  });

  it("registers no promptSections", () => {
    const cap = fileToolsClient({ service: makeMockService() });
    expect(cap.promptSections).toBeUndefined();
  });

  it("produces exactly nine tools matching the expected names", () => {
    const cap = fileToolsClient({ service: makeMockService() });
    const ctx = makeContext("tok");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    expect(tools).toHaveLength(9);
    const names = new Set(tools.map((t) => t.name));
    for (const expected of ALL_TOOL_NAMES) {
      expect(names.has(expected)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Missing __BUNDLE_TOKEN — every tool throws
// ---------------------------------------------------------------------------

describe("fileToolsClient missing __BUNDLE_TOKEN", () => {
  it.each(ALL_TOOL_NAMES)("throws 'Missing __BUNDLE_TOKEN' on %s", async (name) => {
    const service = makeMockService();
    const cap = fileToolsClient({ service });
    const ctx = makeContext(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const tool = toolByName(tools, name);

    // Supply a superset of all methods' arg fields — the tool throws before
    // reading them.
    const args = {
      path: "a.md",
      content: "x",
      old_string: "a",
      new_string: "b",
      source: "s",
      destination: "d",
      pattern: "*.md",
    };

    await expect(tool.execute!(args, ctx as never)).rejects.toThrow("Missing __BUNDLE_TOKEN");
    for (const fn of Object.values(service)) {
      if (typeof fn === "function") expect(fn).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Tool forwarding — each tool forwards (token, args, SCHEMA_CONTENT_HASH)
// ---------------------------------------------------------------------------

describe("fileToolsClient RPC forwarding", () => {
  it("file_read forwards to service.read", async () => {
    const service = makeMockService();
    const cap = fileToolsClient({ service });
    const ctx = makeContext("tok-read");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const tool = toolByName(tools, FILE_READ_TOOL_NAME);

    const out = await tool.execute!({ path: "a.md", offset: 1, limit: 2 }, ctx as never);
    expect(service.read).toHaveBeenCalledOnce();
    const [token, args, hash] = service.read.mock.calls[0];
    expect(token).toBe("tok-read");
    expect(args).toEqual({ path: "a.md", offset: 1, limit: 2 });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
    expect(textOf(out)).toBe("read-result");
  });

  it("file_write forwards to service.write", async () => {
    const service = makeMockService();
    const cap = fileToolsClient({ service });
    const ctx = makeContext("tok-write");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const tool = toolByName(tools, FILE_WRITE_TOOL_NAME);

    await tool.execute!({ path: "a.md", content: "hi" }, ctx as never);
    expect(service.write).toHaveBeenCalledOnce();
    const [token, args, hash] = service.write.mock.calls[0];
    expect(token).toBe("tok-write");
    expect(args).toEqual({ path: "a.md", content: "hi" });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
  });

  it("file_edit forwards to service.edit", async () => {
    const service = makeMockService();
    const cap = fileToolsClient({ service });
    const ctx = makeContext("tok-edit");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const tool = toolByName(tools, FILE_EDIT_TOOL_NAME);

    await tool.execute!(
      { path: "a.md", old_string: "a", new_string: "b", replace_all: true },
      ctx as never,
    );
    const [token, args, hash] = service.edit.mock.calls[0];
    expect(token).toBe("tok-edit");
    expect(args).toEqual({
      path: "a.md",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
  });

  it("file_delete forwards to service.delete", async () => {
    const service = makeMockService();
    const cap = fileToolsClient({ service });
    const ctx = makeContext("tok-del");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const tool = toolByName(tools, FILE_DELETE_TOOL_NAME);

    await tool.execute!({ path: "a.md" }, ctx as never);
    const [token, args, hash] = service.delete.mock.calls[0];
    expect(token).toBe("tok-del");
    expect(args).toEqual({ path: "a.md" });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
  });

  it("file_copy forwards to service.copy", async () => {
    const service = makeMockService();
    const cap = fileToolsClient({ service });
    const ctx = makeContext("tok-cp");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const tool = toolByName(tools, FILE_COPY_TOOL_NAME);

    await tool.execute!({ source: "a", destination: "b" }, ctx as never);
    const [token, args, hash] = service.copy.mock.calls[0];
    expect(token).toBe("tok-cp");
    expect(args).toEqual({ source: "a", destination: "b" });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
  });

  it("file_move forwards to service.move", async () => {
    const service = makeMockService();
    const cap = fileToolsClient({ service });
    const ctx = makeContext("tok-mv");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const tool = toolByName(tools, FILE_MOVE_TOOL_NAME);

    await tool.execute!({ source: "a", destination: "b" }, ctx as never);
    const [token, args, hash] = service.move.mock.calls[0];
    expect(token).toBe("tok-mv");
    expect(args).toEqual({ source: "a", destination: "b" });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
  });

  it("file_list forwards to service.list", async () => {
    const service = makeMockService();
    const cap = fileToolsClient({ service });
    const ctx = makeContext("tok-ls");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const tool = toolByName(tools, FILE_LIST_TOOL_NAME);

    await tool.execute!({ path: "dir", cursor: "c" }, ctx as never);
    const [token, args, hash] = service.list.mock.calls[0];
    expect(token).toBe("tok-ls");
    expect(args).toEqual({ path: "dir", cursor: "c" });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
  });

  it("file_tree forwards to service.tree", async () => {
    const service = makeMockService();
    const cap = fileToolsClient({ service });
    const ctx = makeContext("tok-tree");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const tool = toolByName(tools, FILE_TREE_TOOL_NAME);

    await tool.execute!({ path: "dir", depth: 2 }, ctx as never);
    const [token, args, hash] = service.tree.mock.calls[0];
    expect(token).toBe("tok-tree");
    expect(args).toEqual({ path: "dir", depth: 2 });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
  });

  it("file_find forwards to service.find", async () => {
    const service = makeMockService();
    const cap = fileToolsClient({ service });
    const ctx = makeContext("tok-find");
    // biome-ignore lint/suspicious/noExplicitAny: AgentTool generic variance is irrelevant in tests
    const tools = cap.tools!(ctx) as unknown as AgentTool<any>[];
    const tool = toolByName(tools, FILE_FIND_TOOL_NAME);

    await tool.execute!({ pattern: "*.md", path: "src" }, ctx as never);
    const [token, args, hash] = service.find.mock.calls[0];
    expect(token).toBe("tok-find");
    expect(args).toEqual({ pattern: "*.md", path: "src" });
    expect(hash).toBe(SCHEMA_CONTENT_HASH);
  });
});
