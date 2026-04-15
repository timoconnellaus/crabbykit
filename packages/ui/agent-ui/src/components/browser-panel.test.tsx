import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "./browser-panel";

afterEach(() => {
  cleanup();
});

describe("BrowserPanel", () => {
  it("renders iframe with correct src", () => {
    render(<BrowserPanel debuggerFullscreenUrl="https://debug.bb.com/fullscreen" />);
    const iframe = document.querySelector(
      '[data-agent-ui="browser-panel-iframe"]',
    ) as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.src).toBe("https://debug.bb.com/fullscreen");
  });

  it("shows loading overlay initially", () => {
    render(<BrowserPanel debuggerFullscreenUrl="https://debug.bb.com/fullscreen" />);
    const loading = document.querySelector('[data-agent-ui="browser-panel-loading"]');
    expect(loading).not.toBeNull();
    expect(loading?.textContent).toContain("Loading");
  });

  it("hides loading overlay after iframe loads", () => {
    render(<BrowserPanel debuggerFullscreenUrl="https://debug.bb.com/fullscreen" />);
    const iframe = document.querySelector(
      '[data-agent-ui="browser-panel-iframe"]',
    ) as HTMLIFrameElement;
    fireEvent.load(iframe);
    const loading = document.querySelector('[data-agent-ui="browser-panel-loading"]');
    expect(loading).toBeNull();
  });

  it("displays page URL in the URL bar", () => {
    render(
      <BrowserPanel
        debuggerFullscreenUrl="https://debug.bb.com/fullscreen"
        pageUrl="https://example.com/pricing"
      />,
    );
    const urlText = document.querySelector('[data-agent-ui="browser-panel-url-text"]');
    expect(urlText?.textContent).toBe("https://example.com/pricing");
  });

  it("shows about:blank when no pageUrl", () => {
    render(<BrowserPanel debuggerFullscreenUrl="https://debug.bb.com/fullscreen" />);
    const urlText = document.querySelector('[data-agent-ui="browser-panel-url-text"]');
    expect(urlText?.textContent).toBe("about:blank");
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <BrowserPanel debuggerFullscreenUrl="https://debug.bb.com/fullscreen" onClose={onClose} />,
    );
    const closeBtn = document.querySelector('[data-agent-ui="browser-panel-close-btn"]');
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not render close button when onClose is not provided", () => {
    render(<BrowserPanel debuggerFullscreenUrl="https://debug.bb.com/fullscreen" />);
    const closeBtn = document.querySelector('[data-agent-ui="browser-panel-close-btn"]');
    expect(closeBtn).toBeNull();
  });

  it("shows disconnected overlay when not connected", () => {
    render(
      <BrowserPanel debuggerFullscreenUrl="https://debug.bb.com/fullscreen" connected={false} />,
    );
    const disconnected = document.querySelector('[data-agent-ui="browser-panel-disconnected"]');
    expect(disconnected).not.toBeNull();
    expect(disconnected?.textContent).toContain("Lost Connection");
  });

  it("does not show disconnected overlay when connected", () => {
    render(
      <BrowserPanel debuggerFullscreenUrl="https://debug.bb.com/fullscreen" connected={true} />,
    );
    const disconnected = document.querySelector('[data-agent-ui="browser-panel-disconnected"]');
    expect(disconnected).toBeNull();
  });

  it("shows timeout overlay with idle reason", () => {
    render(
      <BrowserPanel debuggerFullscreenUrl="https://debug.bb.com/fullscreen" timeoutReason="idle" />,
    );
    const overlay = document.querySelector('[data-agent-ui="browser-panel-timeout"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain("inactivity");
  });

  it("shows timeout overlay with max_duration reason", () => {
    render(
      <BrowserPanel
        debuggerFullscreenUrl="https://debug.bb.com/fullscreen"
        timeoutReason="max_duration"
      />,
    );
    const overlay = document.querySelector('[data-agent-ui="browser-panel-timeout"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain("maximum session duration");
  });

  it("does not show timeout overlay when no reason", () => {
    render(<BrowserPanel debuggerFullscreenUrl="https://debug.bb.com/fullscreen" />);
    const overlay = document.querySelector('[data-agent-ui="browser-panel-timeout"]');
    expect(overlay).toBeNull();
  });
});
