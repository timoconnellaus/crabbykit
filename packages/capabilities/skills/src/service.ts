/**
 * SkillsService — host-side WorkerEntrypoint that bundles call to load skills.
 *
 * Bundle-side `skillsClient` proxies to this service via JSRPC with the
 * unified `__BUNDLE_TOKEN`. The service verifies the token with
 * `requiredScope: "skills"`, looks up the installed-skill record via its own
 * D1 binding, reads the skill content from R2, strips frontmatter, and
 * returns the body.
 *
 * Lifecycle hooks (conflict injection, dirty-tracking, registry sync) stay
 * on the static `skills(...)` capability host-side. The Phase 0 host-hook
 * bridge fires them automatically for bundle-originated `skill_load`
 * executions.
 *
 * The HKDF subkey is derived from `AGENT_AUTH_KEY` using the shared
 * `BUNDLE_SUBKEY_LABEL` (`"claw/bundle-v1"`) on first call and cached for
 * the lifetime of the entrypoint instance.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { BUNDLE_SUBKEY_LABEL, deriveVerifyOnlySubkey, verifyToken } from "@crabbykit/bundle-token";
import { SCHEMA_CONTENT_HASH } from "./schemas.js";

export interface SkillsServiceEnv {
  /**
   * Master HMAC secret (string). Used to lazily derive the verify-only
   * subkey on first call via HKDF with label `BUNDLE_SUBKEY_LABEL`.
   */
  AGENT_AUTH_KEY: string;
  /** D1 binding holding the skills registry (same schema as `D1SkillRegistry`). */
  SKILL_REGISTRY: D1Database;
  /** R2 bucket storing skill content under `{STORAGE_NAMESPACE}/skills/{id}/SKILL.md`. */
  STORAGE_BUCKET: R2Bucket;
  /** R2 namespace prefix (typically the agent id). */
  STORAGE_NAMESPACE: string;
}

/**
 * Row shape returned from the `skills` D1 table. Mirrors `D1SkillRegistry`'s
 * schema; the optional `enabled` column is consulted when present to
 * differentiate disabled-but-installed skills from not-installed ones.
 * When the column is absent (standard `D1SkillRegistry` deploys), presence
 * of a row is treated as enabled.
 */
interface SkillLookupRow {
  id: string;
  enabled?: number | string | null;
}

function isLookupRow(row: unknown): row is SkillLookupRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r.id === "string";
}

function isEnabled(row: SkillLookupRow): boolean {
  // If the column is missing entirely, treat the skill as enabled (legacy
  // D1 registries without an enabled column expose installed == enabled).
  if (!("enabled" in row) || row.enabled === undefined || row.enabled === null) {
    return true;
  }
  const v = row.enabled;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const lower = v.toLowerCase();
    return lower !== "0" && lower !== "false" && lower !== "";
  }
  return true;
}

/** Strip YAML frontmatter from SKILL.md content. */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : content;
}

function skillR2Key(namespace: string, skillId: string): string {
  return `${namespace}/skills/${skillId}/SKILL.md`;
}

export class SkillsService extends WorkerEntrypoint<SkillsServiceEnv> {
  private subkeyPromise: Promise<CryptoKey> | null = null;

  /**
   * Lazily derive (and cache) the verify-only HKDF subkey from the master
   * `AGENT_AUTH_KEY`. Uses the unified `BUNDLE_SUBKEY_LABEL`.
   */
  private getSubkey(): Promise<CryptoKey> {
    if (!this.subkeyPromise) {
      if (!this.env.AGENT_AUTH_KEY) {
        throw new Error("SkillsService misconfigured: env.AGENT_AUTH_KEY is missing");
      }
      this.subkeyPromise = deriveVerifyOnlySubkey(this.env.AGENT_AUTH_KEY, BUNDLE_SUBKEY_LABEL);
    }
    return this.subkeyPromise;
  }

  async load(
    token: string,
    args: { name: string },
    schemaHash?: string,
  ): Promise<{ content: string }> {
    // Schema drift detection (cheapest check first)
    if (schemaHash && schemaHash !== SCHEMA_CONTENT_HASH) {
      throw new Error("ERR_SCHEMA_VERSION");
    }

    // Verify token — requires "skills" scope in the unified bundle token
    const subkey = await this.getSubkey();
    const verifyResult = await verifyToken(token, subkey, {
      requiredScope: "skills",
    });
    if (!verifyResult.valid) {
      throw new Error(verifyResult.code);
    }

    const skillId = args.name;

    // Look up the installed skill record directly in D1.
    let row: SkillLookupRow | null = null;
    try {
      const result = await this.env.SKILL_REGISTRY.prepare("SELECT * FROM skills WHERE id = ?")
        .bind(skillId)
        .first();
      row = isLookupRow(result) ? result : null;
    } catch {
      // A D1 failure (missing table, transient error) is treated as
      // "skill not found" — we fail the bundle call closed with a
      // non-throwing text response, matching the static tool's behavior.
      row = null;
    }

    if (!row) {
      return { content: `Skill '${skillId}' not found` };
    }

    if (!isEnabled(row)) {
      return { content: `Skill '${skillId}' is not enabled` };
    }

    // Read skill content from R2 at the namespaced key.
    const obj = await this.env.STORAGE_BUCKET.get(skillR2Key(this.env.STORAGE_NAMESPACE, skillId));
    if (!obj) {
      return { content: `Skill '${skillId}' content not found in storage` };
    }

    const raw = await obj.text();
    return { content: stripFrontmatter(raw) };
  }
}
