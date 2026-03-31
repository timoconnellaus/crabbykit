import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

interface MarkdownContentProps {
  content: string;
}

/**
 * Full markdown renderer for assistant messages.
 * Supports GFM: tables, strikethrough, task lists, autolinks, footnotes.
 * Plus all standard markdown: headings, blockquotes, code blocks, lists, links, images, etc.
 */
export const MarkdownContent = memo(function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <div data-agent-ui="message-content">
      <Markdown remarkPlugins={REMARK_PLUGINS}>{content}</Markdown>
    </div>
  );
});
