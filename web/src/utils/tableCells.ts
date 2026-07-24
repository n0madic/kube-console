// One reading of a Kubernetes Table cell, for everything that touches
// `row.cells`. Three near-identical copies used to live in columnWidths,
// miniTable and podHealth, and they disagreed about non-scalar cells — so the
// same cell could be measured as JSON and rendered as blank. The disagreement
// that *is* deliberate is kept here as a second, named function, next to the
// one it differs from.

/**
 * A cell as it is displayed. The Table API types every column as a scalar
 * (string/integer/number/boolean/date), so an object is a CRD printing
 * something odd: show it as JSON rather than a blank cell that reads as "the
 * server sent nothing".
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

/**
 * A cell as it is *judged* — podHealth's verdicts, not the screen. A non-scalar
 * cell yields "" so the caller sees a value it cannot classify and abstains,
 * exactly as it does for a Table with no Status column at all. Rendering that
 * cell as JSON here would instead fall through to "error" and report a healthy
 * pod as broken on the strength of a shape the printer never emits.
 */
export function scalarCellText(value: unknown): string {
  if (value === null || value === undefined || typeof value === "object") return ""
  return String(value)
}
