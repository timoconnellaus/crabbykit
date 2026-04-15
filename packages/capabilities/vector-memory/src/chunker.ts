// Target chunk size ~400 tokens, overlap ~80 tokens.
// Token estimate: 1 token ~ 4 chars.
const CHUNK_SIZE_CHARS = 1600; // ~400 tokens
const OVERLAP_CHARS = 320; // ~80 tokens

export interface Chunk {
  content: string;
  startLine: number; // 1-based
  endLine: number; // 1-based
  hash: string; // hex SHA-256 of content
}

async function sha256Hex(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface LineRange {
  text: string;
  startLine: number; // 1-based
  endLine: number; // 1-based
}

/**
 * Split content into paragraph blocks (separated by blank lines).
 * Each block carries the 1-based line range it occupies.
 */
function getParagraphs(lines: string[]): LineRange[] {
  const paragraphs: LineRange[] = [];
  let blockLines: string[] = [];
  let blockStart = -1;

  const flush = (endLine: number) => {
    if (blockLines.length > 0) {
      paragraphs.push({
        text: blockLines.join("\n"),
        startLine: blockStart,
        endLine,
      });
      blockLines = [];
      blockStart = -1;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      flush(i); // endLine is 0-based index of the last non-blank line before this blank
    } else {
      if (blockStart === -1) blockStart = i + 1; // 1-based
      blockLines.push(line);
    }
  }
  flush(lines.length); // endLine: treat last line as the upper bound

  return paragraphs;
}

/**
 * Split markdown content into overlapping chunks of ~400 tokens.
 * Splits on paragraph boundaries (double newlines) when possible.
 * Lines are 1-based.
 */
export async function chunkMarkdown(content: string): Promise<Chunk[]> {
  if (content.trim().length === 0) return [];

  const lines = content.split("\n");
  const paragraphs = getParagraphs(lines);

  if (paragraphs.length === 0) return [];

  const chunks: Chunk[] = [];

  let i = 0; // current paragraph index

  while (i < paragraphs.length) {
    // Build a chunk starting at paragraph i
    let chunkText = "";
    const chunkStart = paragraphs[i].startLine;
    let chunkEnd = paragraphs[i].endLine;
    let j = i;

    while (j < paragraphs.length) {
      const para = paragraphs[j];
      const addition = chunkText ? `\n\n${para.text}` : para.text;
      const prospective = chunkText + addition;

      if (prospective.length > CHUNK_SIZE_CHARS && chunkText.length > 0) {
        // Current chunk is full; stop before this paragraph
        break;
      }

      chunkText = prospective;
      chunkEnd = para.endLine;
      j++;
    }

    // j is now the index of the first paragraph NOT included in this chunk
    const finalContent = chunkText.trim();

    if (finalContent.length > 0) {
      const hash = await sha256Hex(finalContent);
      chunks.push({
        content: finalContent,
        startLine: chunkStart,
        endLine: chunkEnd,
        hash,
      });
    }

    // If we consumed all remaining paragraphs, we're done — no overlap needed
    if (j >= paragraphs.length) break;

    // Advance i: to create overlap, step back by enough paragraphs to cover OVERLAP_CHARS
    // Walk backwards from j-1 to find where to start the next chunk
    let overlapChars = 0;
    let nextStart = j; // default: no overlap — start where this chunk ended
    for (let k = j - 1; k > i && overlapChars < OVERLAP_CHARS; k--) {
      overlapChars += paragraphs[k].text.length + 2; // +2 for "\n\n"
      nextStart = k;
    }

    // If we made no progress (single very large paragraph), force advance
    if (nextStart <= i) {
      i = j === i ? i + 1 : j;
    } else {
      i = nextStart;
    }
  }

  return chunks;
}
