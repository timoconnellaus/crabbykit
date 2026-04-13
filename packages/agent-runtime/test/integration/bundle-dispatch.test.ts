/**
 * Bundle dispatch integration tests.
 *
 * Tests the full bundle brain override flow:
 * - defineAgent with bundle config produces a working DO
 * - Static brain runs when no bundle is active
 * - Bundle dispatch intercepts handlePrompt when a bundle is registered
 * - Auto-revert after consecutive load failures
 * - POST /bundle/disable clears the active pointer
 * - Per-entry bundle version tagging
 *
 * These tests require the Cloudflare Workers pool-workers runtime.
 * They are scaffolded here and will be wired up once the test agent DO
 * includes bundle config and a test registry.
 *
 * TODO: Wire to a test DO with bundle config. Requires:
 * - A test agent that extends defineAgent with bundle field
 * - Worker Loader binding in the test wrangler config
 * - InMemoryBundleRegistry seeded with a pre-compiled test bundle
 */

import { describe, expect, it } from "vitest";

describe.todo("bundle dispatch", () => {
  describe("static brain fallback", () => {
    it.todo("runs static brain when no bundle is registered");
    it.todo("runs static brain when bundle config is absent (zero overhead)");
  });

  describe("bundle turn dispatch", () => {
    it.todo("dispatches turn into bundle when active version is set");
    it.todo("mints a fresh capability token per turn");
    it.todo("loads bundle via LOADER.get with content-addressed cache key");
    it.todo("consumes NDJSON event stream from bundle /turn endpoint");
    it.todo("persists assistant entries via SessionStore");
    it.todo("broadcasts events via Transport");
    it.todo("stamps bundleVersionId on entries produced by bundle turns");
    it.todo("stamps bundleVersionId: 'static' on entries produced by static turns");
  });

  describe("auto-revert", () => {
    it.todo("reverts to static brain after 3 consecutive load failures");
    it.todo("clears registry pointer on auto-revert");
    it.todo("logs poison-bundle deployment entry");
    it.todo("resets failure counter on successful turn");
  });

  describe("POST /bundle/disable", () => {
    it.todo("clears active pointer and forces static brain");
    it.todo("returns 401 for unauthenticated requests");
  });

  describe("POST /bundle/refresh", () => {
    it.todo("refreshes cached pointer from registry");
  });

  describe("client event routing", () => {
    it.todo("routes steer messages to bundle POST /client-event");
    it.todo("abort cancels bundle response stream consumption");
  });

  describe("SpineService bridge", () => {
    it.todo("appendEntry via spine bridge persists to session store");
    it.todo("broadcast via spine bridge reaches WebSocket clients");
    it.todo("emitCost via spine bridge persists cost entry");
    it.todo("bad token rejected with ERR_BAD_TOKEN");
    it.todo("expired token rejected with ERR_TOKEN_EXPIRED");
    it.todo("replayed nonce rejected with ERR_TOKEN_REPLAY");
    it.todo("budget enforcement: 101st SQL op returns ERR_BUDGET_EXCEEDED");
  });
});
