/**
 * Content-addressed version ID computation.
 * SHA-256 hex of compiled bundle artifact bytes.
 */

export async function computeVersionId(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
