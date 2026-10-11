/**
 * The Files panel: the session's project tree. Directories expand lazily
 * through the fs API; files open in the viewer (View) or download straight
 * to the device.
 */
import { useEffect, useState, type ReactNode } from "react"
import { client } from "./api"
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  DocumentIcon,
  FolderIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid"
import { downloadFile, FileViewer, fileNameOf } from "./files"

type FsEntry = { path: string; type: "file" | "directory" }

const LIST_CAP = 100

export function FilesPanel({
  sessionDirectory,
  onClose,
}: {
  sessionDirectory?: string
  onClose: () => void
}) {
  const [entries, setEntries] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [viewer, setViewer] = useState<{ path: string; name: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const location = sessionDirectory
    ? { location: { directory: sessionDirectory } }
    : undefined

  const list = async (path?: string) => {
    const key = path ?? ""
    setBusy(key)
    try {
      const res = await client.file.list({
        ...(path ? { path } : {}),
        ...(location ?? {}),
      } as never)
      const data =
        ((res as { data?: FsEntry[] }).data ??
          (res as unknown as FsEntry[])) ?? []
      const sorted = [...data].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1
        return fileNameOf(a.path).localeCompare(fileNameOf(b.path))
      })
      setEntries((prev) => ({ ...prev, [key]: sorted }))
      setError(null)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    setEntries({})
    setExpanded(new Set())
    setViewer(null)
    void list()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionDirectory])

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
        if (!entries[path]) void list(path)
      }
      return next
    })
  }

  const renderRows = (dir: string, depth: number): ReactNode => {
    const all = entries[dir] ?? []
    const shown = all.slice(0, LIST_CAP)
    const pad = { paddingLeft: depth * 14 }
    return (
      <>
        {shown.map((e) => {
          const name = fileNameOf(e.path)
          if (e.type === "directory") {
            const open = expanded.has(e.path)
            return (
              <div key={e.path} style={pad}>
                <button
                  className={"tree-row dir" + (open ? " open" : "")}
                  onClick={() => toggle(e.path)}
                >
                  <span className="tree-caret">{open ? "▾" : "▸"}</span>
                  <span className="tree-icon" aria-hidden="true">
                    <FolderIcon />
                  </span>
                  <span className="tree-name">{name}</span>
                </button>
                {open && renderRows(e.path, depth + 1)}
              </div>
            )
          }
          return (
            <div key={e.path} style={pad}>
              <div className="tree-row file">
                <span className="tree-caret" />
                <span className="tree-icon" aria-hidden="true">
                  <DocumentIcon />
                </span>
                <button
                  className="tree-name"
                  title="View"
                  onClick={() => setViewer({ path: e.path, name })}
                >
                  {name}
                </button>
                <button
                  className="btn-icon"
                  title="Download"
                  aria-label={`Download ${name}`}
                  onClick={() => downloadFile(e.path, sessionDirectory)}
                >
                  <ArrowDownTrayIcon />
                </button>
              </div>
            </div>
          )
        })}
        {all.length > LIST_CAP && (
          <div className="tree-row" style={pad}>
            <span className="tree-name dim">
              … {all.length - LIST_CAP} more
            </span>
          </div>
        )}
        {all.length === 0 && (
          <div className="tree-row" style={pad}>
            <span className="tree-name dim">empty</span>
          </div>
        )}
      </>
    )
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Files</h3>
        <div className="panel-actions">
          <button
            className="btn-icon"
            title="Refresh"
            aria-label="Refresh tree"
            onClick={() => void list()}
          >
            <ArrowPathIcon />
          </button>
          <button className="icon-btn" title="Close" aria-label="Close panel" onClick={onClose}>
            <XMarkIcon />
          </button>
        </div>
      </div>

      {error && <div className="panel-error">{error}</div>}
      {!sessionDirectory && (
        <div className="panel-note">
          Open a session to browse its project.
        </div>
      )}

      <div className="panel-list">
        {busy === "" && !entries[""] && (
          <div className="tree-row">
            <span className="tree-name dim">loading…</span>
          </div>
        )}
        {renderRows("", 0)}
      </div>

      {viewer && (
        <FileViewer
          path={viewer.path}
          name={viewer.name}
          sessionDirectory={sessionDirectory}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  )
}
