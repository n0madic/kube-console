import { describe, expect, it } from "vitest"

import {
  base64ToBytes,
  bytesToBase64,
  decodeBase64Utf8,
  encodeBase64Utf8,
  utf8OrNull,
} from "@/utils/base64"

describe("base64", () => {
  it.each([
    ["ASCII", "s3cret"],
    ["empty", ""],
    ["unicode", "пароль ✓ 密码 🔑"],
    ["PEM-like with trailing newline", "-----BEGIN KEY-----\nabc\n-----END KEY-----\n"],
  ])("round-trips %s text", (_, text) => {
    expect(decodeBase64Utf8(encodeBase64Utf8(text))).toBe(text)
  })

  it("encodes to the standard padded alphabet the apiserver emits", () => {
    expect(encodeBase64Utf8("a")).toBe("YQ==")
    expect(encodeBase64Utf8("ключ")).toBe("0LrQu9GO0Yc=")
  })

  // Past the chunk size the encoder builds the Latin-1 string in pieces; a
  // single spread of the whole array would overflow the argument limit.
  it("encodes values larger than one chunk", () => {
    const bytes = new Uint8Array(0x8000 * 3 + 17).map((_, i) => i % 256)
    const b64 = bytesToBase64(bytes)
    expect(base64ToBytes(b64)).toEqual(bytes)
    expect(b64).toBe(btoa(String.fromCharCode(...Array.from(bytes))))
  })

  it("round-trips arbitrary bytes", () => {
    const b64 = "//4AAQLI"
    expect(bytesToBase64(base64ToBytes(b64))).toBe(b64)
  })

  // Regression: TextDecoder strips a leading BOM by default, so a value saved
  // with one came back three bytes short after decode → encode.
  it("keeps a leading UTF-8 BOM through decode and encode", () => {
    const b64 = bytesToBase64(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))
    const text = utf8OrNull(base64ToBytes(b64))
    expect(text).toBe("\ufeffa")
    expect(encodeBase64Utf8(text!)).toBe(b64)
  })

  it("reports bytes that are not UTF-8 as null", () => {
    expect(utf8OrNull(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull()
    expect(utf8OrNull(new TextEncoder().encode("ok"))).toBe("ok")
  })

  it("keeps the readable placeholder for binary and invalid input", () => {
    expect(decodeBase64Utf8("//4A")).toBe("(binary data — cannot decode as text)")
    expect(decodeBase64Utf8("not base64!")).toBe("(binary data — cannot decode as text)")
  })
})
