/**
 * Bundle workshop integration tests.
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

describe.todo("bundle-workshop integration", () => {
  describe("full workflow: init → build → test → deploy", () => {
    it.todo("bundle_init scaffolds workspace and runs bun install");
    it.todo("bundle_build compiles the scaffolded source");
    it.todo("bundle_test validates the built bundle");
    it.todo("bundle_deploy registers and activates the bundle");
    it.todo("deployed bundle handles a prompt turn");
    it.todo("bundle_disable reverts to static brain");
  });

  describe("error paths", () => {
    it.todo("bundle_build fails with diagnostics on syntax error");
    it.todo("bundle_deploy rejects oversized bundles");
    it.todo("bundle_deploy enforces rate limit");
    it.todo("bundle_rollback swaps active and previous versions");
    it.todo("bundle_rollback fails when no previous version");
  });

  describe("sandbox elevation guard", () => {
    it.todo("bundle_init returns error when sandbox not elevated");
    it.todo("bundle_build returns error when sandbox not elevated");
  });

  describe("audit logging", () => {
    it.todo("successful deploy logs workshop_audit entry");
    it.todo("failed build logs workshop_audit entry with error code");
  });
});
