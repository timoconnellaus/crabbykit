/**
 * In-memory BundleRegistry for tests and demos.
 * Not for production use — state is lost on restart.
 */

import { CapabilityMismatchError } from "@claw-for-cloudflare/agent-runtime";
import { validateCatalogAgainstKnownIds } from "@claw-for-cloudflare/bundle-registry";
import type { BundleRegistry, SetActiveOptions } from "./bundle-config.js";
import {
  ActionIdCollisionError,
  RouteCollisionError,
  validateBundleActionIdsAgainstKnownIds,
  validateBundleRoutesAgainstKnownRoutes,
} from "./validate-routes.js";

interface VersionEntry {
  versionId: string;
  bytes: ArrayBuffer;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

interface AgentPointer {
  activeVersionId: string | null;
  previousVersionId: string | null;
  updatedAt: number;
}

interface DeploymentLog {
  agentId: string;
  versionId: string | null;
  rationale?: string;
  sessionId?: string;
  deployedAt: number;
}

export class InMemoryBundleRegistry implements BundleRegistry {
  private readonly versions = new Map<string, VersionEntry>();
  private readonly pointers = new Map<string, AgentPointer>();
  private readonly deployments: DeploymentLog[] = [];

  /**
   * Pre-seed a bundle version for testing.
   */
  seed(versionId: string, bytes: ArrayBuffer | string, metadata?: Record<string, unknown>): void {
    let buf: ArrayBuffer;
    if (typeof bytes === "string") {
      const encoded = new TextEncoder().encode(bytes);
      buf = new ArrayBuffer(encoded.byteLength);
      new Uint8Array(buf).set(encoded);
    } else {
      buf = bytes;
    }
    this.versions.set(versionId, {
      versionId,
      bytes: buf,
      metadata,
      createdAt: Date.now(),
    });
  }

  /**
   * Pre-set the active version for an agent.
   */
  setActiveSync(agentId: string, versionId: string | null): void {
    const existing = this.pointers.get(agentId);
    this.pointers.set(agentId, {
      activeVersionId: versionId,
      previousVersionId: existing?.activeVersionId ?? null,
      updatedAt: Date.now(),
    });
  }

  // --- BundleRegistry interface ---

  async getActiveForAgent(agentId: string): Promise<string | null> {
    return this.pointers.get(agentId)?.activeVersionId ?? null;
  }

  async setActive(
    agentId: string,
    versionId: string | null,
    options?: SetActiveOptions,
  ): Promise<void> {
    if (versionId !== null) {
      const version = this.versions.get(versionId);
      const required = (version?.metadata as { requiredCapabilities?: Array<{ id: string }> })
        ?.requiredCapabilities;

      // Reserved-scope rejection: "spine" and "llm" cannot be used as
      // capability ids. This runs independently of skipCatalogCheck.
      if (required && required.length > 0) {
        const RESERVED = new Set(["spine", "llm"]);
        for (const req of required) {
          if (req && typeof req.id === "string" && RESERVED.has(req.id)) {
            throw new TypeError(
              `BundleRegistry.setActive: capability id "${req.id}" is a reserved scope string and cannot be used as a capability id — the dispatcher unconditionally grants this scope to all bundles`,
            );
          }
        }
      }

      if (options?.skipCatalogCheck !== true) {
        if (options?.knownCapabilityIds === undefined) {
          throw new TypeError(
            "BundleRegistry.setActive: knownCapabilityIds is required when skipCatalogCheck is not true",
          );
        }
        const result = validateCatalogAgainstKnownIds(
          required,
          new Set(options.knownCapabilityIds),
        );
        if (!result.valid) {
          throw new CapabilityMismatchError({
            missingIds: result.missingIds,
            versionId,
          });
        }

        // bundle-http-and-ui-surface: route + action-id collision guards.
        // Both run only when the version's metadata declares the
        // corresponding `surfaces.*` field AND the caller supplied the
        // matching `known*` snapshot. Cross-deployment promotions that
        // pass `skipCatalogCheck: true` skip both, matching the
        // existing catalog opt-out semantic.
        const surfaces = (
          version?.metadata as
            | {
                surfaces?: {
                  httpRoutes?: Array<{ method: string; path: string }>;
                  actionCapabilityIds?: string[];
                };
              }
            | undefined
        )?.surfaces;

        if (surfaces?.httpRoutes && options?.knownHttpRoutes !== undefined) {
          const routeResult = validateBundleRoutesAgainstKnownRoutes(
            surfaces.httpRoutes,
            options.knownHttpRoutes,
          );
          if (!routeResult.valid) {
            throw new RouteCollisionError({
              collisions: routeResult.collisions,
              versionId,
            });
          }
        }

        if (surfaces?.actionCapabilityIds && options.knownCapabilityIds) {
          const actionResult = validateBundleActionIdsAgainstKnownIds(
            surfaces.actionCapabilityIds,
            options.knownCapabilityIds,
          );
          if (!actionResult.valid) {
            throw new ActionIdCollisionError({
              collidingIds: actionResult.collidingIds,
              versionId,
            });
          }
        }
      }
    }

    const existing = this.pointers.get(agentId);
    this.pointers.set(agentId, {
      activeVersionId: versionId,
      previousVersionId: existing?.activeVersionId ?? null,
      updatedAt: Date.now(),
    });
    this.deployments.push({
      agentId,
      versionId,
      rationale: options?.rationale,
      sessionId: options?.sessionId,
      deployedAt: Date.now(),
    });
  }

  async getBytes(versionId: string): Promise<ArrayBuffer | null> {
    return this.versions.get(versionId)?.bytes ?? null;
  }

  /**
   * Read the version row — mirrors `D1BundleRegistry.getVersion`'s shape
   * with a `metadata` field exposed to the catalog-validation path.
   * Treated as the authoritative source for `requiredCapabilities` in
   * the dispatch-time guard.
   */
  async getVersion(versionId: string): Promise<{
    versionId: string;
    metadata: {
      requiredCapabilities?: Array<{ id: string }>;
      runtimeHash?: string;
      sourceName?: string;
      buildTimestamp?: number;
      lifecycleHooks?: { onAlarm?: boolean; onSessionCreated?: boolean; onClientEvent?: boolean };
      surfaces?: {
        httpRoutes?: Array<{ method: string; path: string; capabilityId?: string }>;
        actionCapabilityIds?: string[];
      };
    } | null;
  } | null> {
    const entry = this.versions.get(versionId);
    if (!entry) return null;
    const meta = entry.metadata as
      | {
          requiredCapabilities?: Array<{ id: string }>;
          runtimeHash?: string;
          sourceName?: string;
          buildTimestamp?: number;
          lifecycleHooks?: {
            onAlarm?: boolean;
            onSessionCreated?: boolean;
            onClientEvent?: boolean;
          };
          surfaces?: {
            httpRoutes?: Array<{ method: string; path: string; capabilityId?: string }>;
            actionCapabilityIds?: string[];
          };
        }
      | undefined;
    return { versionId, metadata: meta ?? null };
  }

  /**
   * Create (or dedupe) a content-addressed bundle version. Mirrors the
   * `createVersion` method on the production D1BundleRegistry so this
   * fixture satisfies the wider `BundleRegistryWriter` interface that
   * `workshop_deploy` requires. Hash format must match
   * `bundle-registry`'s `computeVersionId` (SHA-256 hex) so versionIds
   * are interchangeable across registry implementations.
   */
  async createVersion(opts: {
    bytes: ArrayBuffer;
    createdBy?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    versionId: string;
    kvKey: string;
    sizeBytes: number;
    createdAt: number;
    createdBy: string | null;
    metadata: Record<string, unknown> | null;
  }> {
    const hash = await crypto.subtle.digest("SHA-256", opts.bytes);
    const versionId = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const existing = this.versions.get(versionId);
    if (existing) {
      return {
        versionId,
        kvKey: `bundle:${versionId}`,
        sizeBytes: existing.bytes.byteLength,
        createdAt: existing.createdAt,
        createdBy: opts.createdBy ?? null,
        metadata: (existing.metadata as Record<string, unknown> | undefined) ?? null,
      };
    }
    const createdAt = Date.now();
    this.versions.set(versionId, {
      versionId,
      bytes: opts.bytes,
      metadata: opts.metadata,
      createdAt,
    });
    return {
      versionId,
      kvKey: `bundle:${versionId}`,
      sizeBytes: opts.bytes.byteLength,
      createdAt,
      createdBy: opts.createdBy ?? null,
      metadata: opts.metadata ?? null,
    };
  }

  // --- Test helpers ---

  getDeployments(agentId?: string): DeploymentLog[] {
    if (!agentId) return [...this.deployments];
    return this.deployments.filter((d) => d.agentId === agentId);
  }

  getPointer(agentId: string): AgentPointer | undefined {
    return this.pointers.get(agentId);
  }
}
