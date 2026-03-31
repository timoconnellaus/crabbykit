import { memo, useState } from "react";
import {
  formatDuration,
  summarizeResult,
  summarizeToolInput,
  toolColorCategory,
} from "./chat-utils";
import type { ToolResultInfo } from "./message-list";

export interface ToolCallEntryProps {
  toolName: string;
  toolCallId: string;
  args?: unknown;
  /** Result info from the tool state / persisted result. */
  result?: ToolResultInfo;
  /** Execution duration in milliseconds. */
  duration?: number;
}

export const ToolCallEntry = memo(function ToolCallEntry({
  toolName,
  toolCallId: _toolCallId,
  args,
  result,
  duration,
}: ToolCallEntryProps) {
  const [open, setOpen] = useState(false);
  const category = toolColorCategory(toolName);
  const detail = summarizeToolInput(args);

  const isComplete = result?.status === "complete";
  const isError = isComplete && result.isError;
  const isRunning = !result || result.status === "executing" || result.status === "streaming";

  const outputText = isComplete && result.content ? result.content : null;
  const hasDiff =
    outputText &&
    (outputText.includes("\n+") || outputText.includes("\n-")) &&
    (toolName === "file_write" || toolName === "file_edit");

  const resultSummary = isComplete
    ? summarizeResult(toolName, result.content, result.isError)
    : null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: div used for complex layout with data attributes
    <div
      data-agent-ui="tool-entry"
      data-tool-category={category}
      data-status={result?.status ?? "executing"}
      data-error={isError || undefined}
      data-open={open || undefined}
      role="button"
      tabIndex={0}
      onClick={() => {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        setOpen(!open);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(!open);
        }
      }}
    >
      {/* Collapsed header */}
      <div data-agent-ui="tool-entry-header">
        <span data-agent-ui="tool-entry-name">{toolName}</span>
        {detail && <span data-agent-ui="tool-entry-detail">{detail}</span>}

        {/* Running: spinner */}
        {isRunning && <span data-agent-ui="tool-entry-spinner" data-tool-category={category} />}

        {/* Complete: result summary */}
        {!isRunning && resultSummary && (
          <>
            <span data-agent-ui="tool-entry-sep">{"\u00b7"}</span>
            <span data-agent-ui="tool-entry-result" data-variant={resultSummary.variant}>
              {resultSummary.text}
            </span>
          </>
        )}

        {/* Duration */}
        {duration != null && !isRunning && (
          <span data-agent-ui="tool-entry-duration">{formatDuration(duration)}</span>
        )}
      </div>

      {/* Expanded body */}
      {open && (
        <div
          data-agent-ui="tool-entry-body"
          role="none"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {args != null && (
            <>
              <div data-agent-ui="tool-entry-section-label">input</div>
              <pre data-agent-ui="tool-entry-input">
                {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
              </pre>
            </>
          )}

          {outputText && (
            <>
              <div data-agent-ui="tool-entry-section-label">{hasDiff ? "changes" : "output"}</div>
              <pre data-agent-ui="tool-entry-output" data-error={isError || undefined}>
                {hasDiff
                  ? outputText.split("\n").map((line, i) => {
                      const isDiffAdd = line.startsWith("+") && !line.startsWith("+++");
                      const isDiffRemove = line.startsWith("-") && !line.startsWith("---");
                      const isDiffContext = line.startsWith("@@");
                      return (
                        <div
                          // biome-ignore lint/suspicious/noArrayIndexKey: Diff lines have no stable ID
                          key={i}
                          data-agent-ui={
                            isDiffAdd
                              ? "tool-entry-diff-add"
                              : isDiffRemove
                                ? "tool-entry-diff-remove"
                                : isDiffContext
                                  ? "tool-entry-diff-context"
                                  : undefined
                          }
                        >
                          {line}
                        </div>
                      );
                    })
                  : outputText}
              </pre>
            </>
          )}

          {isError && result.content && !outputText && (
            <div data-agent-ui="tool-entry-error">{result.content}</div>
          )}
        </div>
      )}
    </div>
  );
});
