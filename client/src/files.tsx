/**
 * Files: fetch, download, and view — the desktop's fs API is the transport.
 * One file's bytes arrive as a Uint8Array; text files decode, everything
 * else rides as a Blob with the right mime.
 */
import { useEffect, useState } from "react"
import { client } from "./api"
import { ArrowDownTrayIcon, XMarkIcon } from "@heroicons/react/20/solid"
import { Markdown } from "./markdown"

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
}

/* extensions the browser can render in an <img> — previewable attachments */
const IMG_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico",
])

export const extensionOf = (path: string): string =>
  path.split(".").pop()?.toLowerCase() ?? ""

export const fileNameOf = (path: string): string =>
  path.split(/[\\/]/).pop() || path

/*
   The prompt API attaches files by URI, and the server rejects plain
   filesystem paths ("Unsupported attachment URI") — it wants file://
   (verified on a 2.0.27 server: file:///C:/... resolves and rides into
   the message as base64). Windows and POSIX paths both normalize.
*/
export const fileUri = (path: string): string => {
  // whitelist, not a generic scheme test: a windows drive ("C:\…") would
  // otherwise read as scheme "c:" and skip normalization
  if (/^(file|https?|data|blob):/i.test(path)) return path
  const norm = path.replace(/\\/g, "/")
  return norm.startsWith("/") ? `file://${norm}` : `file:///${norm}`
}

/** One file's bytes from the desktop, as a Blob with the right mime. */
export async function fetchFile(
  path: string,
  sessionDirectory?: string,
): Promise<Blob> {
  // fs.read takes a path RELATIVE to a location directory. Absolute paths
  // (like the ones agents put in markdown links) split into
  // location=<its own directory> + path=<basename> — works for files
  // anywhere on the machine, not just inside the project.
  const absolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/")
  let location: { directory: string } | undefined
  let rel = path
  if (absolute) {
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    location = { directory: path.slice(0, cut) }
    rel = path.slice(cut + 1)
  } else if (sessionDirectory) {
    location = { directory: sessionDirectory }
  }
  const bytes = await client.file.read({
    path: rel,
    ...(location ? { location } : {}),
  } as never)
  const mime = MIME_BY_EXTENSION[extensionOf(path)] ?? "application/octet-stream"
  return new Blob([bytes as unknown as BlobPart], { type: mime })
}

/** Download a file from the desktop through the browser. */
export function downloadFile(path: string, sessionDirectory?: string) {
  void fetchFile(path, sessionDirectory).then((blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = fileNameOf(path)
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  })
}

/*
   The file viewer: markdown renders with the chat's renderer, plain text as
   a pre, PDFs in an iframe, anything else offers a download. Scrim / ✕ /
   Esc dismiss.
*/
export function FileViewer({
  path,
  name,
  sessionDirectory,
  onClose,
}: {
  path: string
  name?: string
  sessionDirectory?: string
  onClose: () => void
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const display = name ?? fileNameOf(path)
  const ext = extensionOf(path)
  const isText = ext === "md" || ext === "markdown" || ext === "txt"

  useEffect(() => {
    let cancelled = false
    let revoke: string | undefined
    setText(null)
    setBlobUrl(null)
    setError(null)
    void (async () => {
      try {
        const blob = await fetchFile(path, sessionDirectory)
        if (isText) {
          const t = await blob.text()
          if (!cancelled) setText(t)
        } else {
          const url = URL.createObjectURL(blob)
          revoke = url
          if (!cancelled) setBlobUrl(url)
        }
      } catch (err) {
        if (!cancelled) setError(String(err))
      }
    })()
    return () => {
      cancelled = true
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [path, sessionDirectory, isText])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <>
      <div className="scrim-high" onClick={onClose} />
      <div className="viewer-host" role="dialog" aria-modal="true" aria-label={display}>
        <div className="viewer-head">
          <h3>{display}</h3>
          <div className="panel-actions">
            <button
              className="btn-icon"
              title="Download"
              aria-label="Download file"
              onClick={() => downloadFile(path, sessionDirectory)}
            >
              <ArrowDownTrayIcon />
            </button>
            <button className="icon-btn" title="Close" aria-label="Close viewer" onClick={onClose}>
              <XMarkIcon />
            </button>
          </div>
        </div>
        {error && <div className="panel-error">{error}</div>}
        {!error && text == null && blobUrl == null && (
          <div className="viewer-loading">loading…</div>
        )}
        {text != null &&
          (ext === "txt" ? (
            <pre className="viewer-text">{text}</pre>
          ) : (
            <div className="viewer-md">
              <Markdown text={text} />
            </div>
          ))}
        {blobUrl != null &&
          (ext === "pdf" ? (
            <iframe className="viewer-frame" src={blobUrl} title={display} />
          ) : IMG_EXTENSIONS.has(ext) ? (
            <img className="viewer-img" src={blobUrl} alt={display} />
          ) : (
            <div className="viewer-binary">
              <p>This file type can't be previewed.</p>
              <button
                className="btn-primary"
                onClick={() => downloadFile(path, sessionDirectory)}
              >
                Download
              </button>
            </div>
          ))}
      </div>
    </>
  )
}
