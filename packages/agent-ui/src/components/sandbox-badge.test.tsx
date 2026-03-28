import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxBadge } from "./sandbox-badge";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("SandboxBadge", () => {
  it("returns null when not elevated", () => {
    const { container } = render(<SandboxBadge elevated={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders when elevated", () => {
    render(<SandboxBadge elevated={true} />);
    const badge = document.querySelector('[data-agent-ui="sandbox-badge"]');
    expect(badge).not.toBeNull();
  });

  it("sets data-elevated attribute", () => {
    render(<SandboxBadge elevated={true} />);
    const badge = document.querySelector('[data-agent-ui="sandbox-badge"]');
    expect(badge?.getAttribute("data-elevated")).toBe("true");
  });

  it("displays Sandbox label", () => {
    render(<SandboxBadge elevated={true} />);
    const label = document.querySelector('[data-agent-ui="sandbox-badge-label"]');
    expect(label?.textContent).toBe("Sandbox");
  });

  it("shows countdown when expiresAt is set", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    render(<SandboxBadge elevated={true} expiresAt={now + 120_000} timeoutSeconds={180} />);

    const timer = document.querySelector('[data-agent-ui="sandbox-badge-timer"]');
    expect(timer).not.toBeNull();
    expect(timer?.textContent).toBe("2m");
  });

  it("formats seconds when under 60", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    render(<SandboxBadge elevated={true} expiresAt={now + 30_000} timeoutSeconds={180} />);

    const timer = document.querySelector('[data-agent-ui="sandbox-badge-timer"]');
    expect(timer?.textContent).toBe("30s");
  });

  it("formats minutes and seconds", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    render(<SandboxBadge elevated={true} expiresAt={now + 90_000} timeoutSeconds={180} />);

    const timer = document.querySelector('[data-agent-ui="sandbox-badge-timer"]');
    expect(timer?.textContent).toBe("1m 30s");
  });

  it("hides timer when no expiresAt", () => {
    render(<SandboxBadge elevated={true} />);
    const timer = document.querySelector('[data-agent-ui="sandbox-badge-timer"]');
    expect(timer).toBeNull();
  });

  it("applies progress gradient style", () => {
    const now = Date.now();
    vi.setSystemTime(now);

    render(<SandboxBadge elevated={true} expiresAt={now + 90_000} timeoutSeconds={180} />);

    const badge = document.querySelector('[data-agent-ui="sandbox-badge"]') as HTMLElement;
    // 90s / 180s = 50%
    expect(badge?.style.background).toContain("50%");
  });
});
