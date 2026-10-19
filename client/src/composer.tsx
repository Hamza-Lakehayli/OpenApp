import { useEffect, useRef, useState } from "react"
import type { ModelInfo, ModelRef, ChatItem, AgentOption } from "./types"
import { ModelPicker, AgentPicker } from "./components"
import { PlusIcon, XMarkIcon } from "@heroicons/react/20/solid"
import { client } from "./api"
import { fileNameOf } from "./files"

export type { ModelInfo, ModelRef, ChatItem, AgentOption }

export type SendMode = "steer" | "queue"

export function Composer({
  disabled,
  running,
  onSend,
  onStop,
  sendMode = "steer",
  onSendMode,
  model,
  models,
  onModelPick,
  agent,
  agents,
  onAgentPick,
  attachments,
  onRemoveAttachment,
  onCompact,
  onPickFile,
  sessionDirectory,
}: {
  disabled: boolean
  running: boolean
  onSend: (text: string, files?: Array<{ uri: string; name: string }>) => void
  onStop: () => void
  /** which lane a busy-session send joins: next step boundary or after the turn */
  sendMode?: SendMode
  onSendMode?: (mode: SendMode) => void
  model?: { id: string; providerID: string; variant?: string }
  models: ModelInfo[]
  onModelPick: (m: ModelInfo) => void
  agent?: string
  agents: AgentOption[]
  onAgentPick: (a: AgentOption) => void
  attachments: Array<{ uri: string; name: string }>
  onRemoveAttachment: (i: number) => void
  onCompact: () => void
  onPickFile: (f: { uri: string; name: string }) => void
  sessionDirectory?: string
}) {
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Array<{ path: string }>>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + "px"
  }, [text])

  const searchFiles = (q: string) => {
    if (!q.trim()) { setResults([]); return }
    setSearching(true)
    client.file.find({
      ...(sessionDirectory ? { location: { directory: sessionDirectory } } : {}),
      query: q,
      type: "file",
      limit: 20,
    }).then((res) => {
      setResults(res.data ?? [])
    }).catch(() => setResults([])).finally(() => setSearching(false))
  }

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed, attachments)
    setText("")
    setResults([])
  }

  return (
    <div className="composer-wrap">
      <div className="composer-row">
        <AgentPicker agent={agent} agents={agents} onPick={onAgentPick} />
        <ModelPicker model={model} models={models} onPick={onModelPick} />
      </div>
      {running && onSendMode && (
        <button
          className="send-mode"
          onClick={() => onSendMode(sendMode === "steer" ? "queue" : "steer")}
          aria-label={
            sendMode === "steer"
              ? "Delivery: steers the running turn at its next step. Tap to queue instead."
              : "Delivery: queues the message until the turn is idle. Tap to steer instead."
          }
        >
          {sendMode === "steer" ? (
            <>
              <b>Steer</b>&nbsp;· applies at the next step
            </>
          ) : (
            <>
              <b>Queue</b>&nbsp;· waits until idle
            </>
          )}
        </button>
      )}
      <div className="composer">
        <button
          className="plus-btn"
          title="Attach / compact"
          aria-label="More"
          disabled={disabled}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <PlusIcon />
        </button>
        {menuOpen && (
          <div className="picker-menu plus-menu">
            <button className="picker-item" onClick={() => { setMenuOpen(false); setPickerOpen(true) }}>
              <span className="picker-item-name">Attach file...</span>
              <span className="picker-item-provider">search the workspace</span>
            </button>
            <button className="picker-item" onClick={() => { setMenuOpen(false); onCompact() }}>
              <span className="picker-item-name">Compact conversation</span>
              <span className="picker-item-provider">summarize to free up context</span>
            </button>
          </div>
        )}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={
            disabled
              ? "Connecting to OpenCode…"
              : running
                ? sendMode === "queue"
                  ? "Queue message…"
                  : "Steer message…"
                : "Send a message…"
          }
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        {attachments.length > 0 && (
          <div className="attach-row">
            {attachments.map((a, i) => (
              <span key={a.uri} className="attach-chip">
                {fileNameOf(a.name || a.uri)}
                <button className="attach-x" aria-label="Remove" onClick={() => onRemoveAttachment(i)}>
                  <XMarkIcon />
                </button>
              </span>
            ))}
          </div>
        )}
        {running ? (
          <>
            {/* delivery follows the pill's mode; Stop stays separate */}
            <button
              className="send steer"
              title={sendMode === "queue" ? "Queue message" : "Steer message"}
              aria-label={sendMode === "queue" ? "Queue message" : "Steer message"}
              disabled={!text.trim() || disabled}
              onClick={send}
            >
              ↪
            </button>
            <button className="send stop" title="Stop" aria-label="Stop" onClick={onStop}>
              ■
            </button>
          </>
        ) : (
          <button
            className="send"
            title="Send"
            aria-label="Send a message"
            disabled={!text.trim() || disabled}
            onClick={send}
          >
            ↑
          </button>
        )}
      </div>
      {pickerOpen && (
        <div className="attach-panel">
          <input
            className="attach-search"
            placeholder="Search files in the workspace..."
            value={query}
            autoFocus
            spellCheck={false}
            onChange={(e) => { setQuery(e.target.value); searchFiles(e.target.value) }}
          />
          {searching && <div className="attach-hint">searching...</div>}
          <div className="attach-results">
            {results.map((r) => (
              <button
                key={r.path}
                className="picker-item"
                onClick={() => {
                  const abs = sessionDirectory && !/^[a-zA-Z]:[\\/]/.test(r.path) && !r.path.startsWith("/")
                    ? sessionDirectory.replace(/[\\/]+$/, "") + "\\" + r.path
                    : r.path
                  onPickFile({ uri: abs, name: fileNameOf(r.path) })
                  setPickerOpen(false)
                  setQuery("")
                  setResults([])
                }}
              >
                <span className="picker-item-name">{fileNameOf(r.path)}</span>
                <span className="picker-item-provider">{r.path}</span>
              </button>
            ))}
            {!searching && query.trim() && results.length === 0 && (
              <div className="attach-hint">no matches</div>
            )}
          </div>
          <button className="btn-ghost attach-close" onClick={() => setPickerOpen(false)}>Close</button>
        </div>
      )}
      <div className="composer-note">
        OpenCode runs on your PC — this session is shared with the desktop.
      </div>
    </div>
  )
}
