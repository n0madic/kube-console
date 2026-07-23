// Saving a fetched response body to a file.
//
// The log endpoint needs the session bearer, so it cannot be handed to the
// browser as a plain link — the body is fetched through apiFetch and handed
// back as a blob, which this turns into a download.

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoking in the same task can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
