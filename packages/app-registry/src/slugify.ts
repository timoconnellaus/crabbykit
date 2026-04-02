/**
 * Derive a URL-safe slug from a human-readable name.
 * Lowercase, replace spaces/special chars with hyphens, collapse consecutive hyphens,
 * trim leading/trailing hyphens.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}
