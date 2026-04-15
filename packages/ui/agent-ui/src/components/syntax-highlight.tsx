import { memo, useEffect, useState } from "react";
import type { BundledLanguage } from "shiki";

/**
 * Lazy-loaded Shiki highlighter singleton.
 * Languages are loaded on demand — only the grammars actually used are fetched.
 */
let highlighterPromise: Promise<
  Awaited<ReturnType<typeof import("shiki")["createHighlighter"]>>
> | null = null;

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((mod) =>
      mod.createHighlighter({
        themes: ["github-dark-default"],
        langs: [],
      }),
    );
  }
  return highlighterPromise;
}

/** Map file extensions to Shiki language identifiers. */
const EXT_TO_LANG: Record<string, BundledLanguage> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".json": "json",
  ".jsonc": "jsonc",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".sql": "sql",
  ".xml": "xml",
  ".svg": "xml",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".dockerfile": "dockerfile",
  ".env": "dotenv",
};

/** Derive a Shiki language from a file path. */
export function langFromPath(path: string): BundledLanguage | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) {
    // Handle extensionless files
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (base === "Dockerfile") return "dockerfile";
    if (base === "Makefile") return "makefile";
    return null;
  }
  const ext = path.slice(dot).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

/** Extract file path from tool args. */
export function extractPath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  // file_read, file_write, file_edit, file_delete all use "path"
  if (typeof obj.path === "string") return obj.path;
  // file_copy, file_move use "destination" for the output file
  if (typeof obj.destination === "string") return obj.destination;
  return null;
}

interface HighlightedCodeProps {
  /** Source code to highlight. */
  code: string;
  /** Shiki language identifier. */
  lang: BundledLanguage | null;
  /** Show line numbers (default true). */
  lineNumbers?: boolean;
  /** Starting line number (default 1). */
  startLine?: number;
  /** Max height in px before scrolling. */
  maxHeight?: number;
}

/**
 * Renders syntax-highlighted code with optional line numbers.
 * Falls back to unhighlighted monospace while Shiki loads.
 */
export const HighlightedCode = memo(function HighlightedCode({
  code,
  lang,
  lineNumbers = true,
  startLine = 1,
  maxHeight = 400,
}: HighlightedCodeProps) {
  const [tokens, setTokens] = useState<Array<Array<{ content: string; color?: string }>> | null>(
    null,
  );

  useEffect(() => {
    if (!lang) return;
    let cancelled = false;

    getHighlighter().then(async (hl) => {
      if (cancelled) return;
      // Load language on demand if not already loaded
      const loaded = hl.getLoadedLanguages();
      if (!loaded.includes(lang)) {
        await hl.loadLanguage(lang);
      }
      if (cancelled) return;

      const result = hl.codeToTokens(code, {
        lang,
        theme: "github-dark-default",
      });
      setTokens(result.tokens);
    });

    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  const lines: Array<Array<{ content: string; color?: string }>> =
    tokens ?? code.split("\n").map((line) => [{ content: line }]);

  return (
    <pre data-agent-ui="highlighted-code" style={{ maxHeight, overflowY: "auto", margin: 0 }}>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Code lines have no stable ID
        <div key={i} data-agent-ui="code-line">
          {lineNumbers && <span data-agent-ui="code-line-num">{startLine + i}</span>}
          <span data-agent-ui="code-line-text">
            {line.map((token, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Tokens have no stable ID
              <span key={j} style={token.color ? { color: token.color } : undefined}>
                {token.content}
              </span>
            ))}
          </span>
        </div>
      ))}
    </pre>
  );
});

interface DiffLineData {
  type: "add" | "remove" | "context";
  content: string;
}

interface HighlightedDiffProps {
  /** Diff lines (already parsed into add/remove/context). */
  lines: DiffLineData[];
  /** Shiki language for syntax coloring the content. */
  lang: BundledLanguage | null;
  /** Max height before scrolling. */
  maxHeight?: number;
}

/**
 * Renders a diff view with syntax-highlighted line content
 * and add/remove background colors.
 */
export const HighlightedDiff = memo(function HighlightedDiff({
  lines,
  lang,
  maxHeight = 400,
}: HighlightedDiffProps) {
  type Token = { content: string; color?: string };
  const [tokenizedLines, setTokenizedLines] = useState<Array<Array<Token>> | null>(null);

  useEffect(() => {
    if (!lang) return;
    let cancelled = false;

    getHighlighter().then(async (hl) => {
      if (cancelled) return;
      const loaded = hl.getLoadedLanguages();
      if (!loaded.includes(lang)) {
        await hl.loadLanguage(lang);
      }
      if (cancelled) return;

      // Highlight each line individually to preserve diff structure
      const results = lines.map((line) => {
        const result = hl.codeToTokens(line.content, {
          lang,
          theme: "github-dark-default",
        });
        return result.tokens[0] ?? [{ content: line.content }];
      });
      setTokenizedLines(results);
    });

    return () => {
      cancelled = true;
    };
  }, [lines, lang]);

  return (
    <pre data-agent-ui="highlighted-diff" style={{ maxHeight, overflowY: "auto", margin: 0 }}>
      {lines.map((line, i) => {
        const tokens: Token[] = tokenizedLines?.[i] ?? [{ content: line.content }];
        const gutter = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: Diff lines have no stable ID
          <div key={i} data-agent-ui="diff-line" data-diff-type={line.type}>
            <span data-agent-ui="diff-gutter">{gutter}</span>
            <span data-agent-ui="diff-line-text">
              {tokens.map((token, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Tokens have no stable ID
                <span key={j} style={token.color ? { color: token.color } : undefined}>
                  {token.content}
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </pre>
  );
});

/**
 * Parse a unified diff string into structured lines.
 * Expects lines starting with +, -, or space (context).
 * Strips @@ hunk headers into their own entries.
 */
export function parseDiffLines(text: string): DiffLineData[] {
  const result: DiffLineData[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      result.push({ type: "context", content: line });
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      result.push({ type: "add", content: line.slice(1) });
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      result.push({ type: "remove", content: line.slice(1) });
    } else {
      result.push({ type: "context", content: line.startsWith(" ") ? line.slice(1) : line });
    }
  }
  return result;
}
