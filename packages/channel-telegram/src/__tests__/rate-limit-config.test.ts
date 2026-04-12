import { describe, expect, it } from "vitest";
import { defineTelegramChannel, type TelegramRateLimitConfig } from "../index.js";

describe("defineTelegramChannel agent-config mapping", () => {
  it("stashes the supplied `config` mapping as agentConfigMapping", () => {
    const mapping = (c: Record<string, unknown>) =>
      (c as { telegram: TelegramRateLimitConfig }).telegram;
    const cap = defineTelegramChannel({ config: mapping });
    expect(cap.agentConfigMapping).toBe(mapping);
  });

  it("omits agentConfigMapping when no mapping supplied", () => {
    const cap = defineTelegramChannel({});
    expect(cap.agentConfigMapping).toBeUndefined();
  });

  it("keeps account storage flow intact (configNamespaces still wired)", () => {
    const cap = defineTelegramChannel({
      config: (c) => (c as { telegram: TelegramRateLimitConfig }).telegram,
    });
    expect(cap.configNamespaces).toBeInstanceOf(Function);
  });
});
