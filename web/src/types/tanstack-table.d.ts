import "@tanstack/vue-table"

declare module "@tanstack/vue-table" {
  interface ColumnMeta<TData, TValue> {
    /** Kubernetes Table column description (used for header tooltips). */
    description?: string
  }
}
