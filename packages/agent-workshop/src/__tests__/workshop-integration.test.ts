/**
 * Agent workshop integration tests.
 *
 * Tests the full init → build → test → deploy workflow against a real
 * sandbox container and registry.
 *
 * These tests require:
 * - Cloudflare Workers pool-workers runtime
 * - A sandbox container (SandboxContainer DO)
 * - D1 + KV bindings for the registry
 *
 * Scaffolded here with .todo() markers.
 */

import { describe, it } from "vitest";

describe.todo("agent-workshop integration", () => {
  describe("full workflow: init → build → test → deploy", () => {
    it.todo("workshop_init scaffolds workspace and runs bun install");
    it.todo("workshop_build compiles the scaffolded source");
    it.todo("workshop_test validates the built bundle");
    it.todo("workshop_deploy registers and activates the bundle");
    it.todo("deployed bundle handles a prompt turn");
    it.todo("workshop_disable reverts to static brain");
  });

  describe("error paths", () => {
    it.todo("workshop_build fails with diagnostics on syntax error");
    it.todo("workshop_deploy rejects oversized bundles");
    it.todo("workshop_deploy enforces rate limit");
    it.todo("workshop_rollback swaps active and previous versions");
    it.todo("workshop_rollback fails when no previous version");
  });

  describe("sandbox elevation guard", () => {
    it.todo("workshop_init returns error when sandbox not elevated");
    it.todo("workshop_build returns error when sandbox not elevated");
  });

  describe("audit logging", () => {
    it.todo("successful deploy logs workshop_audit entry");
    it.todo("failed build logs workshop_audit entry with error code");
  });
});
