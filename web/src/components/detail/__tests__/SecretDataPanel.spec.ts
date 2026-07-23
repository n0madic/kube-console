import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"

import type { K8sObject } from "@/api/types"
import SecretDataPanel from "@/components/detail/SecretDataPanel.vue"

/** Base64 of a UTF-8 string (mirrors what the API returns for Secret data). */
function b64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
}

function secret(uid: string, data: Record<string, string>): K8sObject {
  return { metadata: { uid, name: uid }, data }
}

describe("SecretDataPanel", () => {
  it("decodes multibyte UTF-8 values correctly", async () => {
    const wrapper = mount(SecretDataPanel, {
      props: { object: secret("s1", { pw: b64("naïve-pÿ-Ω") }) },
    })
    await wrapper.find("button").trigger("click") // reveal
    expect(wrapper.find("pre").text()).toBe("naïve-pÿ-Ω")
  })

  it("shows the fallback message for non-text binary data", async () => {
    // 0xFF is an invalid UTF-8 start byte → not decodable as text.
    const wrapper = mount(SecretDataPanel, {
      props: { object: secret("s1", { blob: btoa("\xff\xfe\x00") }) },
    })
    await wrapper.find("button").trigger("click")
    expect(wrapper.find("pre").text()).toContain("binary data")
  })

  it("resets the reveal state when the Secret changes (no auto-disclosure)", async () => {
    const wrapper = mount(SecretDataPanel, {
      props: { object: secret("s1", { password: b64("secret-A") }) },
    })
    await wrapper.find("button").trigger("click") // reveal A's password
    expect(wrapper.find("pre").exists()).toBe(true)
    expect(wrapper.text()).toContain("secret-A")

    // Navigate to a different Secret that also has a "password" key.
    await wrapper.setProps({ object: secret("s2", { password: b64("secret-B") }) })

    // B's value must stay masked until an explicit reveal.
    expect(wrapper.find("pre").exists()).toBe(false)
    expect(wrapper.text()).not.toContain("secret-B")
    expect(wrapper.text()).toContain("••••••••")
  })
})
