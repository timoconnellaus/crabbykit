import type { PromptSection, PromptSectionSource } from "@claw-for-cloudflare/agent-runtime";
import { useSystemPrompt } from "@claw-for-cloudflare/agent-runtime/client";
import { type ComponentPropsWithoutRef, useCallback, useEffect, useMemo, useState } from "react";
import { MarkdownContent } from "./markdown-content";

export interface SystemPromptPanelProps extends ComponentPropsWithoutRef<"div"> {
  /** Whether the panel is open. */
  open: boolean;
  /** Called when the user clicks the close button. */
  onClose: () => void;
}

/**
 * Source-kind label for the pill. Shows *where* the section came from (the
 * source type) rather than *what* it is (the section name already conveys
 * that). Colour reinforces the kind visually.
 */
function sourceLabel(source: PromptSectionSource): string {
  switch (source.type) {
    case "default":
      return "default";
    case "additional":
      return "additional";
    case "tools":
      return "tools";
    case "tool-guidance":
      return "guidance";
    case "custom":
      return "custom";
    case "capability":
      return "capability";
  }
}

/** Kebab-case key for CSS color coding per source type. */
function sourceKind(source: PromptSectionSource): string {
  return source.type;
}

/**
 * Slide-in panel that displays the current system prompt as structured sections.
 *
 * Sections start collapsed; click a header to expand one, or use the toolbar
 * controls to expand or collapse all at once. Each section row carries a
 * source pill (default block / tools / capability / custom) coloured by
 * source kind. Sections that the runtime declared as excluded — for example,
 * a capability whose precondition wasn't met — are dimmed and show their
 * exclusion reason inline.
 */
export function SystemPromptPanel({ open, onClose, ...props }: SystemPromptPanelProps) {
  const { systemPrompt, requestSystemPrompt } = useSystemPrompt();
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
    setExpanded(new Set(systemPrompt.sections.filter((s) => s.included).map((s) => s.key)));
  }, [systemPrompt]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  const sections = systemPrompt?.sections ?? [];

  const stats = useMemo(() => {
    let included = 0;
    let excluded = 0;
    let tokens = 0;
    for (const s of sections) {
      if (s.included) {
        included += 1;
        tokens += s.tokens;
      } else {
        excluded += 1;
      }
    }
    return { included, excluded, tokens };
  }, [sections]);

  if (!open) return null;

  return (
    <div data-agent-ui="system-prompt-panel" {...props}>
      {/* Header — title row + toolbar row */}
      <header data-agent-ui="system-prompt-header">
        <div data-agent-ui="system-prompt-titlebar">
          <div data-agent-ui="system-prompt-meta">
            <span data-agent-ui="system-prompt-title">system prompt</span>
            {sections.length > 0 && (
              <span data-agent-ui="system-prompt-stats">
                <span>{stats.included} shown</span>
                {stats.excluded > 0 && (
                  <>
                    <span data-agent-ui="system-prompt-stats-sep">·</span>
                    <span>{stats.excluded} hidden</span>
                  </>
                )}
                <span data-agent-ui="system-prompt-stats-sep">·</span>
                <span>~{stats.tokens.toLocaleString()} tokens</span>
              </span>
            )}
          </div>
          <button
            type="button"
            data-agent-ui="system-prompt-close"
            onClick={onClose}
            aria-label="Close system prompt panel"
            title="Close"
          >
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div data-agent-ui="system-prompt-toolbar">
          <div data-agent-ui="system-prompt-toolbar-group">
            {viewMode === "md" && sections.length > 0 && (
              <div data-agent-ui="system-prompt-expand-controls">
                <button type="button" onClick={expandAll} title="Expand every section">
                  expand all
                </button>
                <button type="button" onClick={collapseAll} title="Collapse every section">
                  collapse all
                </button>
              </div>
            )}
          </div>

          <div data-agent-ui="system-prompt-toolbar-group">
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
            <button
              type="button"
              data-agent-ui="system-prompt-copy"
              onClick={handleCopy}
              aria-label={copied ? "Copied" : "Copy prompt"}
              title="Copy full prompt"
              data-copied={copied || undefined}
            >
              {copied ? (
                <svg
                  aria-hidden="true"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg
                  aria-hidden="true"
                  width="13"
                  height="13"
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
          </div>
        </div>
      </header>

      {/* Body */}
      <div data-agent-ui="system-prompt-body">
        {!systemPrompt && <div data-agent-ui="system-prompt-loading">loading…</div>}

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
  const kind = sourceKind(section.source);
  return (
    <div
      data-agent-ui="system-prompt-section"
      data-section-key={section.key}
      data-source-kind={kind}
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
          {excluded ? "−" : expanded ? "⌄" : "›"}
        </span>
        <span data-agent-ui="system-prompt-section-name">{section.name}</span>
        <span data-agent-ui="system-prompt-source-pill" data-source-kind={kind}>
          {sourceLabel(section.source)}
        </span>
        <span data-agent-ui="system-prompt-section-spacer" />
        {excluded ? (
          <span data-agent-ui="system-prompt-section-tag">skipped</span>
        ) : (
          <span data-agent-ui="system-prompt-section-lines">~{section.tokens} tokens</span>
        )}
      </button>
      {excluded && (
        <div data-agent-ui="system-prompt-section-excluded">
          {section.excludedReason ?? "no reason provided"}
        </div>
      )}
      {expanded && !excluded && (
        <div data-agent-ui="system-prompt-section-content">
          <MarkdownContent content={section.content} />
        </div>
      )}
    </div>
  );
}
