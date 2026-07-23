// The project's icon set, in one place — rendered by `components/ui/AppIcon.vue`.
//
// There is no icon dependency: an SPA embedded in the binary must not fetch
// glyphs at runtime, and a dozen icons is not enough mass to justify a build
// plugin. So the paths live here instead of being copy-pasted into templates,
// where the same glyph had already been drawn twice.
//
// The 24x24 outline glyphs are Heroicons v2 outline (Tailwind Labs, MIT) —
// the attribution this set never had while it was inlined. The 20x20 glyphs
// are drawn for this UI.

export interface IconDef {
  view: string
  paths: string[]
  /** Stroke width for outline glyphs; omitted means a filled glyph. */
  stroke?: number
}

export const ICONS = {
  "arrow-path": {
    view: "0 0 24 24",
    stroke: 2,
    paths: [
      "M16.023 9.348h4.992V4.356m0 4.992l-3.181-3.183a8.25 8.25 0 00-13.803 3.7M2.985 14.652H7.98v4.992m-4.994-4.992l3.182 3.182a8.25 8.25 0 0013.803-3.7",
    ],
  },
  "arrow-down-tray": {
    view: "0 0 24 24",
    stroke: 2,
    paths: [
      "M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3",
    ],
  },
  eye: {
    view: "0 0 24 24",
    stroke: 2,
    paths: [
      "M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z",
      "M15 12a3 3 0 11-6 0 3 3 0 016 0z",
    ],
  },
  "eye-slash": {
    view: "0 0 24 24",
    stroke: 2,
    paths: [
      "M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88",
    ],
  },
  "computer-desktop": {
    view: "0 0 24 24",
    stroke: 2,
    paths: [
      "M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25",
    ],
  },
  sun: {
    view: "0 0 24 24",
    stroke: 2,
    paths: [
      "M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z",
    ],
  },
  moon: {
    view: "0 0 24 24",
    stroke: 2,
    paths: [
      "M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z",
    ],
  },
  layers: {
    view: "0 0 20 20",
    stroke: 1.5,
    paths: ["M10 2 3 5.5 10 9l7-3.5L10 2zM3 10l7 3.5L17 10M3 14.5 10 18l7-3.5"],
  },
  // One caret for both the cluster picker and the sidebar sections, which used
  // to carry two hand-drawn variants of the same triangle.
  "caret-down": {
    view: "0 0 20 20",
    paths: ["M5.5 7.5 10 12l4.5-4.5z"],
  },
  grid: {
    view: "0 0 20 20",
    paths: ["M3 3h6v6H3V3zm8 0h6v4h-6V3zM3 11h6v6H3v-6zm8 2h6v4h-6v-4z"],
  },
} satisfies Record<string, IconDef>

export type IconName = keyof typeof ICONS
