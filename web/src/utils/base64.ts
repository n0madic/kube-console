// Decode a base64 string (Kubernetes Secret values) as UTF-8. atob yields a
// Latin-1 byte string; re-decode it as UTF-8 so multibyte values render
// correctly. fatal:true makes genuine binary (invalid UTF-8) fall through to a
// readable message instead of showing mojibake.
export function decodeBase64Utf8(b64: string): string {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return "(binary data — cannot decode as text)"
  }
}
