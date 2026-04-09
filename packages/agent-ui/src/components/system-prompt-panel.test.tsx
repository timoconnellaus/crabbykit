import type { PromptSection, PromptSectionSource } from "@claw-for-cloudflare/agent-runtime";
import type { UseAgentChatReturn } from "@claw-for-cloudflare/agent-runtime/client";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatProvider } from "./chat-provider";
import { SystemPromptPanel } from "./system-prompt-panel";

afterEach(() => {
  cleanup();
});

const q = (attr: string) => document.querySelector(`[data-agent-ui="${attr}"]`);
const qAll = (attr: string) => Array.from(document.querySelectorAll(`[data-agent-ui="${attr}"]`));

function makeSection(
  overrides: Partial<PromptSection> & { key: string; source: PromptSectionSource },
): PromptSection {
  const content = overrides.content ?? `content for ${overrides.key}`;
  return {
    name: overrides.key,
    content,
    lines: overrides.lines ?? content.split("\n").length,
    included: overrides.included ?? true,
    ...overrides,
  };
}

function mockChat(
  sections: PromptSection[] | null,
  requestSystemPrompt = vi.fn(),
): UseAgentChatReturn {
  return {
    messages: [],
    connectionStatus: "connected",
    agentStatus: "idle",
    sessions: [],
    currentSessionId: null,
    thinking: null,
    completedThinking: null,
    toolStates: new Map(),
    costs: [],
    schedules: [],
    availableCommands: [],
    capabilityState: {},
    skills: [],
    systemPrompt:
      sections === null
        ? null
        : {
            sections,
            raw: sections
              .filter((s) => s.included)
              .map((s) => s.content)
              .join("\n\n"),
          },
    queuedMessages: [],
    error: null,
    requestSystemPrompt,
    sendMessage: vi.fn(),
    steerMessage: vi.fn(),
    deleteQueuedMessage: vi.fn(),
    steerQueuedMessage: vi.fn(),
    sendCommand: vi.fn(),
    abort: vi.fn(),
    switchSession: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
    toggleSchedule: vi.fn(),
  } as unknown as UseAgentChatReturn;
}

function renderPanel(sections: PromptSection[] | null, onClose = vi.fn()) {
  const chat = mockChat(sections);
  return render(
    <ChatProvider chat={chat}>
      <SystemPromptPanel open={true} onClose={onClose} />
    </ChatProvider>,
  );
}

describe("SystemPromptPanel", () => {
  it("renders nothing when closed", () => {
    const chat = mockChat([]);
    render(
      <ChatProvider chat={chat}>
        <SystemPromptPanel open={false} onClose={() => {}} />
      </ChatProvider>,
    );
    expect(q("system-prompt-panel")).toBeNull();
  });

  it("calls requestSystemPrompt on open", () => {
    const request = vi.fn();
    const chat = mockChat(null, request);
    render(
      <ChatProvider chat={chat}>
        <SystemPromptPanel open={true} onClose={() => {}} />
      </ChatProvider>,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("shows loading when systemPrompt is null", () => {
    renderPanel(null);
    expect(q("system-prompt-loading")?.textContent).toBe("Loading...");
  });

  it("starts with every section collapsed (no content bodies rendered)", () => {
    renderPanel([
      makeSection({
        key: "identity",
        source: { type: "default", id: "identity" },
        content: "I am an agent.",
      }),
      makeSection({
        key: "cap-skills-1",
        name: "Skills",
        source: { type: "capability", capabilityId: "skills", capabilityName: "Skills" },
        content: "## Available Skills\n- thing",
      }),
    ]);
    expect(qAll("system-prompt-section")).toHaveLength(2);
    expect(qAll("system-prompt-section-content")).toHaveLength(0);
  });

  it("toggles an individual section when its header is clicked", () => {
    renderPanel([
      makeSection({
        key: "identity",
        source: { type: "default", id: "identity" },
        content: "I am an agent.",
      }),
      makeSection({
        key: "safety",
        source: { type: "default", id: "safety" },
        content: "Be safe.",
      }),
    ]);
    const headers = qAll("system-prompt-section-header");
    expect(headers).toHaveLength(2);

    fireEvent.click(headers[0]);
    expect(qAll("system-prompt-section-content")).toHaveLength(1);

    fireEvent.click(headers[0]);
    expect(qAll("system-prompt-section-content")).toHaveLength(0);
  });

  it("expand all expands every included section, collapse all clears them", () => {
    renderPanel([
      makeSection({ key: "a", source: { type: "default", id: "identity" }, content: "a" }),
      makeSection({ key: "b", source: { type: "tools" }, content: "b" }),
      makeSection({
        key: "c",
        source: { type: "capability", capabilityId: "x", capabilityName: "X" },
        content: "c",
      }),
    ]);

    const controls = q("system-prompt-expand-controls")!;
    const [expandAll, collapseAll] = Array.from(
      controls.querySelectorAll("button"),
    ) as HTMLButtonElement[];

    fireEvent.click(expandAll);
    expect(qAll("system-prompt-section-content")).toHaveLength(3);

    fireEvent.click(collapseAll);
    expect(qAll("system-prompt-section-content")).toHaveLength(0);
  });

  it("renders excluded sections with reason, dimmed, and no body", () => {
    renderPanel([
      makeSection({
        key: "cap-skills-1",
        name: "Skills",
        source: { type: "capability", capabilityId: "skills", capabilityName: "Skills" },
        content: "",
        lines: 0,
        included: false,
        excludedReason: "No skills enabled",
      }),
    ]);

    const section = q("system-prompt-section") as HTMLElement;
    expect(section.getAttribute("data-excluded")).toBe("true");

    const excluded = q("system-prompt-section-excluded");
    expect(excluded?.textContent).toContain("No skills enabled");

    // Header is rendered as a disabled button; clicking should not reveal a body.
    const header = q("system-prompt-section-header") as HTMLButtonElement;
    expect(header.disabled).toBe(true);
    fireEvent.click(header);
    expect(qAll("system-prompt-section-content")).toHaveLength(0);

    // "Expand all" should also leave it collapsed (excluded).
    const expandAll = (q("system-prompt-expand-controls") as HTMLElement).querySelectorAll(
      "button",
    )[0] as HTMLButtonElement;
    fireEvent.click(expandAll);
    expect(qAll("system-prompt-section-content")).toHaveLength(0);
  });

  it("renders source pills with per-source labels and data-source-kind", () => {
    renderPanel([
      makeSection({ key: "identity", source: { type: "default", id: "identity" } }),
      makeSection({ key: "auto-tools", source: { type: "tools" } }),
      makeSection({
        key: "cap-web-search-1",
        name: "Web Search",
        source: { type: "capability", capabilityId: "web-search", capabilityName: "Web Search" },
      }),
      makeSection({ key: "custom", source: { type: "custom" } }),
    ]);

    const pills = qAll("system-prompt-source-pill");
    expect(pills).toHaveLength(4);
    expect(pills[0].textContent).toBe("default: identity");
    expect(pills[0].getAttribute("data-source-kind")).toBe("default");
    expect(pills[1].textContent).toBe("tools");
    expect(pills[1].getAttribute("data-source-kind")).toBe("tools");
    expect(pills[2].textContent).toBe("capability: web-search");
    expect(pills[2].getAttribute("data-source-kind")).toBe("capability");
    expect(pills[3].textContent).toBe("custom");
    expect(pills[3].getAttribute("data-source-kind")).toBe("custom");
  });

  it("stats count included/excluded/lines correctly", () => {
    renderPanel([
      makeSection({
        key: "identity",
        source: { type: "default", id: "identity" },
        content: "a\nb\nc",
        lines: 3,
      }),
      makeSection({
        key: "safety",
        source: { type: "default", id: "safety" },
        content: "x",
        lines: 1,
      }),
      makeSection({
        key: "cap-skills-1",
        name: "Skills",
        source: { type: "capability", capabilityId: "skills", capabilityName: "Skills" },
        content: "",
        lines: 0,
        included: false,
        excludedReason: "none",
      }),
    ]);

    const stats = q("system-prompt-stats")?.textContent ?? "";
    expect(stats).toContain("2 shown");
    expect(stats).toContain("1 hidden");
    expect(stats).toContain("4 lines");
  });

  it("copy button writes only included section content to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).navigator = { clipboard: { writeText } };

    renderPanel([
      makeSection({
        key: "identity",
        source: { type: "default", id: "identity" },
        content: "hello",
      }),
      makeSection({
        key: "cap-skills-1",
        name: "Skills",
        source: { type: "capability", capabilityId: "skills", capabilityName: "Skills" },
        content: "",
        included: false,
        excludedReason: "none",
      }),
      makeSection({
        key: "runtime",
        source: { type: "default", id: "runtime" },
        content: "world",
      }),
    ]);

    const copy = q("system-prompt-copy") as HTMLButtonElement;
    fireEvent.click(copy);

    expect(writeText).toHaveBeenCalledWith("hello\n\nworld");
  });
});
