import type { SqlStore } from "@claw-for-cloudflare/agent-runtime";
import type { AgentStorage } from "@claw-for-cloudflare/agent-storage";
import type { SandboxProvider } from "@claw-for-cloudflare/sandbox";

/** Persisted app record. */
export interface AppRecord {
  id: string;
  name: string;
  slug: string;
  currentVersion: number;
  hasBackend: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Persisted app version record. */
export interface AppVersion {
  appId: string;
  version: number;
  deployId: string;
  commitHash: string;
  message: string | null;
  files: string[];
  hasBackend: boolean;
  deployedAt: string;
}

/** Configuration for backend support. */
export interface BackendOptions {
  /** WorkerLoader binding for bundling and serving the backend worker. */
  loader: WorkerLoader;
  /** Service binding to the DbService WorkerEntrypoint. */
  dbService: Service;
}

/** Configuration options for the app-registry capability. */
export interface AppRegistryOptions {
  /** The sandbox execution provider (for git, build, and file operations). */
  provider: SandboxProvider;
  /** SQL store for app registry persistence (typically from createCfSqlStore). */
  sql: SqlStore;
  /** Shared agent storage (R2 bucket + namespace). */
  storage: AgentStorage;
  /**
   * Enable backend support. When provided, agents can deploy full-stack apps
   * with a bundled Worker backend.
   */
  backend?: BackendOptions;
}

/** Options for the app serving request handler. */
export interface AppRequestOptions {
  /** The incoming request from the worker fetch handler. */
  request: Request;
  /** The agent Durable Object namespace (used to normalize UUIDs to hex IDs). */
  agentNamespace: DurableObjectNamespace;
  /** The R2 bucket containing deploy assets. */
  storageBucket: R2Bucket;
  /** The worker loader binding. */
  loader: WorkerLoader;
  /** DbService service binding (required for apps with backends). */
  dbService?: Service;
}
