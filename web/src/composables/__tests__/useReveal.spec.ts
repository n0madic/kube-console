import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { defineComponent, h, ref, type Ref } from "vue"

import { useReveal } from "@/composables/useReveal"

function useInHost<T>(
  keyOf: (item: T) => string,
  resetOn?: Ref<unknown>,
): ReturnType<typeof useReveal<T>> {
  let reveal!: ReturnType<typeof useReveal<T>>
  const Host = defineComponent({
    setup() {
      reveal = useReveal<T>(keyOf, resetOn === undefined ? undefined : () => resetOn.value)
      return () => h("div")
    },
  })
  mount(Host)
  return reveal
}

describe("useReveal", () => {
  it("toggles an item's revealed state", () => {
    const reveal = useInHost<string>((k) => k)
    expect(reveal.isRevealed("a")).toBe(false)
    reveal.toggle("a")
    expect(reveal.isRevealed("a")).toBe(true)
    reveal.toggle("a")
    expect(reveal.isRevealed("a")).toBe(false)
  })

  it("tracks items independently", () => {
    const reveal = useInHost<string>((k) => k)
    reveal.toggle("a")
    expect(reveal.isRevealed("a")).toBe(true)
    expect(reveal.isRevealed("b")).toBe(false)
  })

  it("reset() clears everything", () => {
    const reveal = useInHost<string>((k) => k)
    reveal.toggle("a")
    reveal.toggle("b")
    reveal.reset()
    expect(reveal.isRevealed("a")).toBe(false)
    expect(reveal.isRevealed("b")).toBe(false)
  })

  it("auto-resets when the resetOn source changes", async () => {
    const uid = ref("obj-1")
    const reveal = useInHost<string>((k) => k, uid)
    reveal.toggle("a")
    expect(reveal.isRevealed("a")).toBe(true)

    uid.value = "obj-2" // e.g. navigating to a different object
    await Promise.resolve()
    expect(reveal.isRevealed("a")).toBe(false)
  })

  it("keys by keyOf, so distinct items with the same key share state", () => {
    interface Row {
      id: number
      name: string
    }
    const reveal = useInHost<Row>((r) => r.name)
    reveal.toggle({ id: 1, name: "TOKEN" })
    // A different object with the same key is considered revealed too.
    expect(reveal.isRevealed({ id: 2, name: "TOKEN" })).toBe(true)
    expect(reveal.isRevealed({ id: 3, name: "OTHER" })).toBe(false)
  })
})
