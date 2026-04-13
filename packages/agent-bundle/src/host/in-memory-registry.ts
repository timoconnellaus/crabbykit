/**
 * In-memory BundleRegistry for tests and demos.
 * Not for production use — state is lost on restart.
 */

import type { BundleRegistry } from "./bundle-config.js";

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
    opts?: { rationale?: string; sessionId?: string },
  ): Promise<void> {
    const existing = this.pointers.get(agentId);
    this.pointers.set(agentId, {
      activeVersionId: versionId,
      previousVersionId: existing?.activeVersionId ?? null,
      updatedAt: Date.now(),
    });
    this.deployments.push({
      agentId,
      versionId,
      rationale: opts?.rationale,
      sessionId: opts?.sessionId,
      deployedAt: Date.now(),
    });
  }

  async getBytes(versionId: string): Promise<ArrayBuffer | null> {
    return this.versions.get(versionId)?.bytes ?? null;
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
