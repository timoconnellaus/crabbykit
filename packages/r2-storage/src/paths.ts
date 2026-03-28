/**
 * Path validation and normalization for R2 storage keys.
 */

const MAX_PATH_BYTES = 512;

export interface PathValidationResult {
  valid: true;
  normalizedPath: string;
}

export interface PathValidationError {
  valid: false;
  error: string;
}

export type PathValidation = PathValidationResult | PathValidationError;

/**
 * Validates and normalizes a user-supplied path.
 *
 * Rejects:
 * - Paths containing `..` segments (directory traversal)
 * - Paths containing null bytes
 * - Paths longer than 512 bytes after normalization
 * - Empty paths after normalization
 *
 * Normalizes:
 * - Replaces backslashes with forward slashes
 * - Strips leading `/` and `./`
 * - Bare `.` treated as empty (rejected)
 */
export function validatePath(path: string): PathValidation {
  if (path.includes("\0")) {
    return { valid: false, error: "Path must not contain null bytes" };
  }

  // Normalize backslashes so segment checks work uniformly
  const normalized = path.replace(/\\/g, "/");

  // Check for .. segments (traversal)
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "..") {
      return { valid: false, error: "Path must not contain '..' segments" };
    }
  }

  // Strip leading / and ./
  let clean = normalized;
  while (clean.startsWith("/") || clean.startsWith("./")) {
    if (clean.startsWith("./")) {
      clean = clean.slice(2);
    } else {
      clean = clean.slice(1);
    }
  }

  // Bare "." means current directory — treat as empty
  if (clean === ".") {
    clean = "";
  }

  if (clean.length === 0) {
    return { valid: false, error: "Path must not be empty after normalization" };
  }

  if (new TextEncoder().encode(clean).byteLength > MAX_PATH_BYTES) {
    return { valid: false, error: "Path must not exceed 512 bytes" };
  }

  return { valid: true, normalizedPath: clean };
}

/**
 * Resolves a validated normalized path to an R2 key.
 * Prepends the configured prefix to isolate storage per-agent (or per-consumer).
 */
export function toR2Key(prefix: string, normalizedPath: string): string {
  return `${prefix}/${normalizedPath}`;
}

/**
 * Resolves the R2 list prefix for a directory path.
 * Returns `{ prefix }` on success or `{ error }` on failure.
 */
export function resolveListPrefix(
  path: string | undefined,
  storagePrefix: string,
): { prefix: string } | { error: string } {
  if (!path || path.trim() === "" || path.trim() === ".") {
    return { prefix: `${storagePrefix}/` };
  }

  const validation = validatePath(path);
  if (!validation.valid) {
    return { error: validation.error };
  }

  return { prefix: `${storagePrefix}/${validation.normalizedPath}/` };
}

/**
 * Converts a glob pattern to a RegExp.
 *
 * Rules:
 * - `**` matches any characters including `/`
 * - `*`  matches any characters except `/`
 * - `?`  matches any single character except `/`
 * - All other regex special characters are escaped
 */
export function globToRegex(pattern: string): RegExp {
  let regexStr = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*" && pattern[i + 1] === "*") {
      // `**` — match anything including path separators
      regexStr += ".*";
      i += 2;
      // Skip a trailing slash after ** so `src/**` matches `src/foo/bar`
      if (pattern[i] === "/") {
        regexStr += "(?:.+/)?";
        i++;
      }
    } else if (char === "*") {
      // `*` — match anything except `/`
      regexStr += "[^/]*";
      i++;
    } else if (char === "?") {
      // `?` — match any single char except `/`
      regexStr += "[^/]";
      i++;
    } else {
      // Escape regex special characters
      regexStr += escapeRegexChar(char);
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`);
}

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/;

function escapeRegexChar(char: string): string {
  if (REGEX_SPECIAL.test(char)) {
    return `\\${char}`;
  }
  return char;
}
