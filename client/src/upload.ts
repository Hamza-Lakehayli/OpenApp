/*
   Phone → PC file upload. The launcher (same origin) saves the bytes on
   the PC under client/uploads/ and answers with the absolute path, which
   then rides into the prompt like any workspace file reference. The
   OpenCode API attaches files by path only — there is no upload endpoint
   on the server itself, so the launcher provides one.

   XHR instead of fetch: only XHR reports upload progress and supports
   aborting, which the composer needs for its progress bar + cancel chip.
*/
export function uploadFile(
  file: File,
  onProgress?: (pct: number) => void,
): { promise: Promise<{ uri: string; name: string }>; cancel: () => void } {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<{ uri: string; name: string }>(
    (resolve, reject) => {
      xhr.open(
        "POST",
        `/_agentlink/upload?name=${encodeURIComponent(file.name || "upload.bin")}`,
      )
      xhr.setRequestHeader("content-type", "application/octet-stream")
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total)
      }
      xhr.onload = () => {
        let data: { path?: string; error?: string }
        try {
          data = JSON.parse(xhr.responseText)
        } catch {
          data = {}
        }
        if (xhr.status === 200 && data.path) {
          const name = data.path.split(/[\\/]/).pop() || file.name
          resolve({ uri: data.path, name })
        } else {
          reject(new Error(data.error || `upload failed (HTTP ${xhr.status})`))
        }
      }
      xhr.onerror = () => reject(new Error("upload failed (network error)"))
      xhr.onabort = () =>
        reject(new DOMException("upload cancelled", "AbortError"))
      xhr.send(file)
    },
  )
  return { promise, cancel: () => xhr.abort() }
}
