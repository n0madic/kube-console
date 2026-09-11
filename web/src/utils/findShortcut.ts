// Is this keydown the browser's Find shortcut (Ctrl/Cmd+F)?
//
// Matched the way the browser binds it: by the character when the layout
// produces a Latin letter, and by the physical key only when it does not.
// Colemak's Ctrl+F is on the physical KeyE, and its physical KeyF types "t" —
// so matching `code === "KeyF"` alone hijacked Ctrl+T (new tab) and left the
// real Ctrl+F to the browser's own Find, which is what the interception
// replaces. A Russian layout yields `key === "а"` on KeyF, and CapsLock
// yields "F", which is why neither rule is enough on its own.

export function isFindShortcut(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false
  if (e.key.toLowerCase() === "f") return true
  return e.code === "KeyF" && !/^[a-z]$/i.test(e.key)
}
