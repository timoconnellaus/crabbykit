import type { AgentContext, AnyAgentTool } from "@claw-for-cloudflare/agent-runtime";
import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type {
  BundleRegistryWriter,
  BundleVersion,
  CreateVersionOpts,
  SetActiveOptions,
} from "@claw-for-cloudflare/bundle-registry";

/** In-memory R2 bucket backing the workshop test suite. */
export function createMockR2Bucket() {
  const store = new Map<string, string>();
  return {
    store,
    bucket: {
      async get(key: string) {
        const value = store.get(key);
        if (value == null) return null;
        return {
          async text() {
            return value;
          },
        };
      },
      async put(key: string, value: string | ArrayBuffer | Uint8Array) {
        const text =
          typeof value === "string"
            ? value
            : value instanceof ArrayBuffer
              ? new TextDecoder().decode(value)
              : new TextDecoder().decode(value);
        store.set(key, text);
        return {};
      },
      async delete(key: string) {
        store.delete(key);
      },
      async head(key: string) {
        return store.has(key) ? {} : null;
      },
      async list(opts: { prefix: string }) {
        const keys = Array.from(store.keys())
          .filter((k) => k.startsWith(opts.prefix))
          .sort();
        return {
          objects: keys.map((key) => ({ key })),
          truncated: false,
        };
      },
    },
  };
}

export function createMockStorage(namespace = "ns", mock = createMockR2Bucket()) {
  const storage: AgentStorage = {
    bucket: () => mock.bucket as unknown as R2Bucket,
    namespace: () => namespace,
  };
  return { storage, mock };
}

/** In-memory bundle registry satisfying BundleRegistryWriter. */
export function createMockRegistry() {
  const versions = new Map<string, { bytes: ArrayBuffer; version: BundleVersion }>();
  const active = new Map<string, string | null>();
  const setActiveCalls: Array<{
    agentId: string;
    versionId: string | null;
    opts?: SetActiveOptions;
  }> = [];

  const registry: BundleRegistryWriter = {
    async getActiveForAgent(agentId: string) {
      return active.get(agentId) ?? null;
    },
    async setActive(agentId, versionId, opts) {
      active.set(agentId, versionId);
      setActiveCalls.push({ agentId, versionId, opts });
    },
    async getBytes(versionId) {
      return versions.get(versionId)?.bytes ?? null;
    },
    async createVersion(opts: CreateVersionOpts) {
      const hash = await sha256Hex(opts.bytes);
      const versionId = hash.slice(0, 32);
      const existing = versions.get(versionId);
      if (existing) return existing.version;
      const version: BundleVersion = {
        versionId,
        kvKey: `bundle:${versionId}`,
        sizeBytes: opts.bytes.byteLength,
        createdAt: Date.now(),
        createdBy: opts.createdBy ?? null,
        metadata: opts.metadata ?? null,
      };
      versions.set(versionId, { bytes: opts.bytes, version });
      return version;
    },
  };
  return { registry, versions, active, setActiveCalls };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Extract a tool result's text content. */
export function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  const r = result as { content?: Array<{ type: string; text: string }> };
  if (r?.content?.[0]?.type === "text") return r.content[0].text;
  return JSON.stringify(result);
}

/** Minimal agent context stub — only the fields workshop reads. */
export interface MockContextOptions {
  agentId?: string;
  sessionId?: string;
  notifyBundlePointerChanged?: () => Promise<void>;
  /** Host capability ids returned from `context.getBundleHostCapabilityIds`.
   *  Workshop passes this to `setActive` as `knownCapabilityIds` so tests
   *  can drive catalog validation end to end. Defaults to `[]`. */
  hostCapabilityIds?: string[];
}

export function createMockContext(
  options: MockContextOptions = {},
): AgentContext & { broadcastCalls: Array<{ event: string; data: unknown }> } {
  const broadcastCalls: Array<{ event: string; data: unknown }> = [];
  return {
    agentId: options.agentId ?? "agent-test",
    sessionId: options.sessionId ?? "session-test",
    stepNumber: 0,
    emitCost: () => {},
    broadcast: (event, data) => broadcastCalls.push({ event, data }),
    broadcastToAll: () => {},
    requestFromClient: () => Promise.reject(new Error("not implemented")),
    storage: {
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
      list: async () => [],
    } as unknown as import("@claw-for-cloudflare/agent-runtime").CapabilityStorage,
    broadcastState: () => {},
    schedules: {} as unknown as import("@claw-for-cloudflare/agent-runtime").ScheduleManager,
    rateLimit: {} as unknown as import("@claw-for-cloudflare/agent-runtime").RateLimiter,
    notifyBundlePointerChanged: options.notifyBundlePointerChanged,
    getBundleHostCapabilityIds: () => options.hostCapabilityIds ?? [],
    broadcastCalls,
  } as unknown as AgentContext & {
    broadcastCalls: Array<{ event: string; data: unknown }>;
  };
}

/** Find a tool by name. */
export function findTool(tools: AnyAgentTool[], name: string): AnyAgentTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

/** Execute a tool, returning the text of the result. */
export async function runTool(tool: AnyAgentTool, args: Record<string, unknown>): Promise<string> {
  const result = await tool.execute(
    args as never,
    {
      toolCallId: `test-${Date.now()}`,
    } as never,
  );
  return textOf(result);
}
