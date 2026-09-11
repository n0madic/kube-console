// Closes a popup when the pointer goes down outside its root element.
//
// One listener for the three hand-built popups (ContextListbox,
// EditableCombobox, PopoverMenu), which used to carry a copy each: whatever
// changes here — a `pointerdown` for touch, portals to account for — must
// change in all of them at once. Escape is deliberately *not* here: each
// popup handles it in its own keydown switch, where it competes with the
// arrow keys and Enter of that control.

import { onBeforeUnmount, onMounted, type Ref } from "vue"

export function useDismissOnOutside(root: Ref<HTMLElement | null>, close: () => void): void {
  function onDocumentPointerDown(event: MouseEvent): void {
    if (root.value !== null && !root.value.contains(event.target as Node)) close()
  }
  onMounted(() => document.addEventListener("mousedown", onDocumentPointerDown))
  onBeforeUnmount(() => document.removeEventListener("mousedown", onDocumentPointerDown))
}
