import { type ComponentPropsWithoutRef, useCallback, useEffect, useState } from "react";
import { useChat } from "./chat-provider";
import { MarkdownContent } from "./markdown-content";

export interface SystemPromptPanelProps extends ComponentPropsWithoutRef<"div"> {
  /** Whether the panel is open. */
  open: boolean;
  /** Called when the user clicks the close button. */
  onClose: () => void;
}

/**
 * Slide-in panel that displays the current system prompt in structured sections.
 * Fetches prompt data via WebSocket when opened. Uses `useChat()` context.
 */
export function SystemPromptPanel({ open, onClose, ...props }: SystemPromptPanelProps) {
  const { systemPrompt, requestSystemPrompt } = useChat();
  const [viewMode, setViewMode] = useState<"md" | "raw">("md");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) requestSystemPrompt();
  }, [open, requestSystemPrompt]);

  const handleCopy = useCallback(() => {
    if (!systemPrompt) return;
    const text =
      viewMode === "raw"
        ? systemPrompt.raw
        : systemPrompt.sections
            .map((s) => s.content)
            .filter(Boolean)
            .join("\n\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [systemPrompt, viewMode]);

  if (!open) return null;

  const sections = systemPrompt?.sections ?? [];
  const totalLines = sections.reduce((sum, s) => sum + s.lines, 0);

  return (
    <div data-agent-ui="system-prompt-panel" {...props}>
      {/* Header */}
      <div data-agent-ui="system-prompt-header">
        <div data-agent-ui="system-prompt-meta">
          <span data-agent-ui="system-prompt-title">system prompt</span>
          {sections.length > 0 && (
            <span data-agent-ui="system-prompt-stats">
              {sections.length} sections &middot; {totalLines} lines
            </span>
          )}
        </div>
        <div data-agent-ui="system-prompt-actions">
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
          sections.map((section) => (
            <div
              key={section.key}
              data-agent-ui="system-prompt-section"
              data-section-key={section.key}
            >
              <div data-agent-ui="system-prompt-section-header">
                <span data-agent-ui="system-prompt-section-dot" />
                <span data-agent-ui="system-prompt-section-name">{section.name}</span>
                <span data-agent-ui="system-prompt-section-lines">{section.lines} ln</span>
              </div>
              <div data-agent-ui="system-prompt-section-content">
                <MarkdownContent content={section.content} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
