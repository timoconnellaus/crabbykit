import type { PromptSection, PromptSectionSource } from "@claw-for-cloudflare/agent-runtime";
import { type ComponentPropsWithoutRef, useCallback, useEffect, useMemo, useState } from "react";
import { useChat } from "./chat-provider";
import { MarkdownContent } from "./markdown-content";

export interface SystemPromptPanelProps extends ComponentPropsWithoutRef<"div"> {
  /** Whether the panel is open. */
  open: boolean;
  /** Called when the user clicks the close button. */
  onClose: () => void;
}

/**
 * Human-readable label for a section's source, used inside the source pill.
 * Deliberately short — the pill sits next to the section name.
 */
function sourceLabel(source: PromptSectionSource): string {
  switch (source.type) {
    case "default":
      return `default: ${source.id}`;
    case "additional":
      return `additional #${source.index}`;
    case "tools":
      return "tools";
    case "tool-guidance":
      return "tool guidance";
    case "custom":
      return "custom";
    case "capability":
      return `capability: ${source.capabilityId}`;
  }
}

/**
 * Kebab-case key for CSS color coding per source type.
 */
function sourceKind(source: PromptSectionSource): string {
  return source.type;
}

/**
 * Slide-in panel that displays the current system prompt in structured sections.
 *
 * - Fetches prompt data via WebSocket when opened via {@link useChat}.
 * - All sections start collapsed. Individual headers toggle a section; the
 *   "Expand all" / "Collapse all" controls operate on every section at once.
 * - Each section header shows a source pill attributing the content to its
 *   origin (default block, tool list, capability, custom override).
 * - Sections the runtime declared as excluded (e.g. a capability whose
 *   condition wasn't met) render in a dimmed row with the exclusion reason
 *   inline — no expand body.
 */
export function SystemPromptPanel({ open, onClose, ...props }: SystemPromptPanelProps) {
  const { systemPrompt, requestSystemPrompt } = useChat();
  const [viewMode, setViewMode] = useState<"md" | "raw">("md");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (open) requestSystemPrompt();
  }, [open, requestSystemPrompt]);

  const handleCopy = useCallback(() => {
    if (!systemPrompt) return;
    const text =
      viewMode === "raw"
        ? systemPrompt.raw
        : systemPrompt.sections
            .filter((s) => s.included)
            .map((s) => s.content)
            .join("\n\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [systemPrompt, viewMode]);

  const toggleSection = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    if (!systemPrompt) return;
    setExpanded(new Set(systemPrompt.sections.map((s) => s.key)));
  }, [systemPrompt]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  const sections = systemPrompt?.sections ?? [];

  const stats = useMemo(() => {
    let included = 0;
    let excluded = 0;
    let lines = 0;
    for (const s of sections) {
      if (s.included) {
        included += 1;
        lines += s.lines;
      } else {
        excluded += 1;
      }
    }
    return { included, excluded, lines };
  }, [sections]);

  if (!open) return null;

  return (
    <div data-agent-ui="system-prompt-panel" {...props}>
      {/* Header */}
      <div data-agent-ui="system-prompt-header">
        <div data-agent-ui="system-prompt-meta">
          <span data-agent-ui="system-prompt-title">system prompt</span>
          {sections.length > 0 && (
            <span data-agent-ui="system-prompt-stats">
              {stats.included} shown
              {stats.excluded > 0 ? ` · ${stats.excluded} hidden` : ""} · {stats.lines} lines
            </span>
          )}
        </div>
        <div data-agent-ui="system-prompt-actions">
          {/* Expand / Collapse all */}
          {viewMode === "md" && sections.length > 0 && (
            <div data-agent-ui="system-prompt-expand-controls">
              <button type="button" onClick={expandAll} title="Expand all sections">
                Expand all
              </button>
              <button type="button" onClick={collapseAll} title="Collapse all sections">
                Collapse all
              </button>
            </div>
          )}
          {/* View mode toggle */}
          <div data-agent-ui="system-prompt-toggle">
            <button
              type="button"
              data-active={viewMode === "md" || undefined}
              onClick={() => setViewMode("md")}
              title="Rendered markdown"
            >
              Md
            </button>
            <button
              type="button"
              data-active={viewMode === "raw" || undefined}
              onClick={() => setViewMode("raw")}
              title="Raw source"
            >
              Raw
            </button>
          </div>
          {/* Copy */}
          <button
            type="button"
            data-agent-ui="system-prompt-copy"
            onClick={handleCopy}
            title="Copy full prompt"
          >
            {copied ? (
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
          {/* Close */}
          <button type="button" data-agent-ui="system-prompt-close" onClick={onClose} title="Close">
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div data-agent-ui="system-prompt-body">
        {!systemPrompt && <div data-agent-ui="system-prompt-loading">Loading...</div>}

        {viewMode === "raw" && systemPrompt ? (
          <pre data-agent-ui="system-prompt-raw">{systemPrompt.raw}</pre>
        ) : (
          sections.map((section) => {
            const isExpanded = expanded.has(section.key);
            return (
              <SystemPromptSection
                key={section.key}
                section={section}
                expanded={isExpanded}
                onToggle={() => toggleSection(section.key)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

interface SystemPromptSectionProps {
  section: PromptSection;
  expanded: boolean;
  onToggle: () => void;
}

function SystemPromptSection({ section, expanded, onToggle }: SystemPromptSectionProps) {
  const excluded = !section.included;
  return (
    <div
      data-agent-ui="system-prompt-section"
      data-section-key={section.key}
      data-source-kind={sourceKind(section.source)}
      data-excluded={excluded || undefined}
      data-expanded={expanded || undefined}
    >
      <button
        type="button"
        data-agent-ui="system-prompt-section-header"
        onClick={onToggle}
        aria-expanded={expanded}
        disabled={excluded}
      >
        <span data-agent-ui="system-prompt-section-chevron" aria-hidden="true">
          {excluded ? "•" : expanded ? "▾" : "▸"}
        </span>
        <span data-agent-ui="system-prompt-section-dot" />
        <span data-agent-ui="system-prompt-section-name">{section.name}</span>
        <span
          data-agent-ui="system-prompt-source-pill"
          data-source-kind={sourceKind(section.source)}
        >
          {sourceLabel(section.source)}
        </span>
        {excluded ? (
          <span data-agent-ui="system-prompt-section-excluded">
            skipped: {section.excludedReason ?? "no reason provided"}
          </span>
        ) : (
          <span data-agent-ui="system-prompt-section-lines">{section.lines} ln</span>
        )}
      </button>
      {expanded && !excluded && (
        <div data-agent-ui="system-prompt-section-content">
          <MarkdownContent content={section.content} />
        </div>
      )}
    </div>
  );
}
