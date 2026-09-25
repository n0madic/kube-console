// Base64 helpers for Kubernetes Secret values, which are arbitrary bytes on the
// wire and UTF-8 text in the common case.

/** Decode base64 to bytes. Throws on input that is not valid base64. */
export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

// btoa takes a Latin-1 string; building it in chunks keeps the spread under the
// engine's argument-count limit for multi-megabyte values.
const CHUNK = 0x8000

/** Encode bytes as standard (padded) base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Bytes as UTF-8 text, or null when they are not valid UTF-8 (binary data).
 * `ignoreBOM` keeps a leading BOM in the text: stripped, the decoded-edit round
 * trip would re-encode the value three bytes short on an unrelated Apply.
 */
export function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

/** Encode UTF-8 text as base64. */
export function encodeBase64Utf8(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

// Decode a base64 string (Kubernetes Secret values) as UTF-8. fatal:true makes
// genuine binary (invalid UTF-8) fall through to a readable message instead of
// showing mojibake.
export function decodeBase64Utf8(b64: string): string {
  try {
    const text = utf8OrNull(base64ToBytes(b64))
    if (text !== null) return text
  } catch {
    // invalid base64: same message as binary
  }
  return "(binary data — cannot decode as text)"
}
