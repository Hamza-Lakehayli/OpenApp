import { useEffect, useRef, useState, type ReactNode } from "react"
import type {
  ModelInfo,
  ModelRef,
  SessionInfo,
  ChatItem,
  Block,
  AgentOption,
} from "./types"
import { Markdown } from "./markdown"
import { recentModels } from "./recent"

/* ---------- helpers ---------- */

function useOutside(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [onClose])
  return ref
}

/* ---------- model picker ---------- */

export function ModelPicker({
  model,
  models,
  onPick,
}: {
  model?: ModelRef
  models: ModelInfo[]
  onPick: (m: ModelInfo) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useOutside(() => setOpen(false))
  const current = models.find(
    (m) => m.id === model?.id && m.providerID === model?.providerID,
  )
  const label = current?.name ?? model?.id ?? "Model"

  const isCurrent = (m: ModelInfo) =>
    m.id === model?.id && m.providerID === model?.providerID
  const recent = recentModels(models)
  const rest = models.filter((m) => !recent.includes(m) || isCurrent(m))

  const renderItem = (m: ModelInfo) => (
    <button
      key={`${m.providerID}/${m.id}`}
      className={"picker-item" + (isCurrent(m) ? " selected" : "")}
      onClick={() => {
        onPick(m)
        setOpen(false)
      }}
    >
      <span className="picker-item-name">{m.name}</span>
      <span className="picker-item-provider">{m.providerID}</span>
    </button>
  )

  return (
    <div className="picker" ref={ref}>
      <button className="picker-btn" onClick={() => setOpen(!open)}>
        {label}
        <span className="picker-caret">▾</span>
      </button>
      {open && (
        <div className="picker-menu">
          {recent.length > 0 && (
            <div className="picker-group-label">Recently used</div>
          )}
          {recent.map(renderItem)}
          {recent.length > 0 && rest.length > 0 && (
            <div className="picker-group-label">All models</div>
          )}
          {rest.map(renderItem)}
        </div>
      )}
    </div>
  )
}

/* ---------- agent (mode) picker ---------- */

export type { AgentOption }

export function AgentPicker({
  agent,
  agents,
  onPick,
}: {
  agent?: string
  agents: AgentOption[]
  onPick: (a: AgentOption) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useOutside(() => setOpen(false))
  const current = agents.find((a) => a.id === agent)
  const label = current?.name ?? agent ?? "Mode"

  return (
    <div className="picker" ref={ref}>
      <button className="picker-btn" onClick={() => setOpen(!open)}>
        {label}
        <span className="picker-caret">▾</span>
      </button>
      {open && (
        <div className="picker-menu">
          {agents.map((a) => (
            <button
              key={a.id}
              className={"picker-item" + (a.id === agent ? " selected" : "")}
              onClick={() => {
                onPick(a)
                setOpen(false)
              }}
            >
              <span className="picker-item-name">{a.name}</span>
              {a.description && (
                <span className="picker-item-provider">{a.description}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- tool call block ---------- */

type ToolBlockData = Extract<Block, { type: "tool" }>

function ToolBlock({ block }: { block: ToolBlockData }) {
  const [open, setOpen] = useState(false)
  const done = block.state === "completed"
  const failed = block.state === "error"
  return (
    <div className={"tool" + (failed ? " failed" : "")}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={"tool-dot" + (done ? " ok" : failed ? " bad" : " run")} />
        <span className="tool-name">{block.name}</span>
        <span className="tool-state">{failed ? "error" : done ? "done" : block.state}</span>
        <span className="tool-caret">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="tool-body">
          <pre className="tool-io">{block.input}</pre>
          {block.output && <pre className="tool-io out">{block.output}</pre>}
        </div>
      )}
    </div>
  )
}

/* ---------- reasoning block ---------- */

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="reasoning">
      <button className="reasoning-head" onClick={() => setOpen(!open)}>
        <span className="reasoning-icon">◇</span> Thinking
        <span className="tool-caret">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  )
}

/* ---------- chat message list ---------- */

export function ChatView({ items, streaming }: { items: ChatItem[]; streaming: boolean }) {
  const endRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener("scroll", onScroll)
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  useEffect(() => {
    if (stickRef.current) endRef.current?.scrollIntoView({ behavior: "auto" })
  }, [items])

  return (
    <div className="chat-scroll" ref={scrollRef}>
      <div className="chat-inner">
        {items.map((item) => {
          if (item.kind === "user") {
            return (
              <div key={item.id} className="row user">
                <div className="bubble-user">{item.text}</div>
              </div>
            )
          }
          if (item.kind === "system") {
            return (
              <div key={item.id} className="row system">
                <div className="bubble-system">{item.text}</div>
              </div>
            )
          }
          return (
            <div key={item.id} className="row assistant">
              {item.error && <div className="assistant-error">{item.error}</div>}
              {item.blocks.map((block: Block, i: number) => {
                const key = `${item.id}-${i}`
                if (block.type === "text")
                  return <Markdown key={key} text={block.text} />
                if (block.type === "reasoning")
                  return <ReasoningBlock key={key} text={block.text} />
                return <ToolBlock key={key} block={block} />
              })}
              {!item.done && streaming && <span className="cursor" />}
            </div>
          )
        })}
        <div ref={endRef} />
      </div>
    </div>
  )
}

/* ---------- empty state: greeting + composer, no dead-end button ---------- */

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-mark">◧</div>
      <h2>What should we work on?</h2>
      <p>Your OpenCode sessions, live from the desktop.</p>
      {children}
    </div>
  )
}

/* ---------- sidebar ---------- */

type Gesture = {
  startX: number
  startY: number
  width: number
  from: "edge" | "drawer" | "scrim"
  locked: null | "open" | "close"
  moved: boolean
  lastX: number
  lastT: number
  velocity: number
}

/*
   The drawer: slides in via ☰, or is pulled open with a left-to-right drag
   from the left edge. While dragging it follows the finger 1:1 (the
   transition is off) and on release it springs to open/closed with
   --ease-standard. Drags from inside the drawer close it — axis-locked, so
   vertical scrolls of the session list stay native (`touch-action: pan-y`).
*/
export function Sidebar({
  sessions,
  activeId,
  onSelect,
  onCreate,
  onArchive,
  onRestore,
  onDeleteForever,
  open,
  onOpen,
  onClose,
}: {
  sessions: SessionInfo[]
  activeId?: string
  onSelect: (id: string) => void
  onCreate: () => void
  onArchive: (id: string) => void
  onRestore: (id: string) => void
  onDeleteForever: (id: string) => void
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const asideRef = useRef<HTMLElement | null>(null)
  const [dragX, setDragX] = useState<number | null>(null) // drawer offset (px, ≤ 0) while dragging
  const gesture = useRef<Gesture | null>(null)
  const suppressClick = useRef(false)
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onClose])

  const track = (g: Gesture, e: PointerEvent) => {
    const dt = e.timeStamp - g.lastT
    if (dt > 0) g.velocity = (e.clientX - g.lastX) / dt
    g.lastX = e.clientX
    g.lastT = e.timeStamp
  }

  const moveImpl = (e: PointerEvent) => {
    const g = gesture.current
    if (!g) return
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY

    if (g.locked === null) {
      // axis lock: horizontal drags belong to the drawer, vertical to the list
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
      if (Math.abs(dy) > Math.abs(dx)) {
        // vertical intent: hand the gesture back to native scroll
        detachRef.current?.()
        gesture.current = null
        return
      }
      g.locked = "close"
    }
    g.moved = true
    track(g, e)
    setDragX(
      g.locked === "open"
        ? Math.min(0, -g.width + Math.max(0, dx)) // pulled out of its closed position
        : Math.min(0, dx), // dragged back from its open position
    )
  }

  const endImpl = (e: PointerEvent) => {
    const g = gesture.current
    detachRef.current?.()
    gesture.current = null
    if (!g) return

    if (!g.moved) {
      // a tap, not a drag: only the scrim dismisses
      if (g.from === "scrim") onClose()
      return
    }
    // a horizontal drag ending inside the drawer must not click a row
    if (g.from === "drawer") suppressClick.current = true

    const dx = e.clientX - g.startX
    const offset =
      g.locked === "open"
        ? Math.min(0, -g.width + Math.max(0, dx))
        : Math.min(0, dx)
    const past = Math.abs(offset) > g.width * 0.4
    const flicked = Math.abs(g.velocity) > 0.4
    const settleOpen =
      g.locked === "open"
        ? past || (flicked && g.velocity > 0)
        : !past || (flicked && g.velocity > 0)
    if (settleOpen) onOpen()
    else onClose()
    // drop the inline offset: the class transform animates the spring back
    setDragX(null)
  }

  // the document-level listeners read the latest closures through refs
  const moveRef = useRef(moveImpl)
  const endRef = useRef(endImpl)
  moveRef.current = moveImpl
  endRef.current = endImpl
  const detachRef = useRef<(() => void) | null>(null)

  useEffect(() => () => detachRef.current?.(), [])

  const begin = (e: React.PointerEvent, from: Gesture["from"]) => {
    if (e.pointerType === "mouse" && e.button !== 0) return
    if (gesture.current || detachRef.current) return
    gesture.current = {
      startX: e.clientX,
      startY: e.clientY,
      width: asideRef.current?.offsetWidth ?? 300,
      from,
      locked: from === "edge" ? "open" : null, // the edge strip only opens; the others axis-lock first
      moved: false,
      lastX: e.clientX,
      lastT: e.timeStamp,
      velocity: 0,
    }
    // track at the document level — no setPointerCapture, which would
    // retarget the derived click and eat taps on buttons inside the drawer
    const onMove = (ev: PointerEvent) => moveRef.current(ev)
    const onEnd = (ev: PointerEvent) => endRef.current(ev)
    document.addEventListener("pointermove", onMove, { passive: true })
    document.addEventListener("pointerup", onEnd)
    document.addEventListener("pointercancel", onEnd)
    detachRef.current = () => {
      document.removeEventListener("pointermove", onMove)
      document.removeEventListener("pointerup", onEnd)
      document.removeEventListener("pointercancel", onEnd)
      detachRef.current = null
    }
  }

  const archivedOf = (s: SessionInfo) =>
    Boolean((s.metadata as { archived?: number } | undefined)?.archived)
  const active = sessions.filter((s) => !archivedOf(s))
  const archived = sessions.filter(archivedOf)

  const groups: { label: string; sessions: SessionInfo[] }[] = []
  for (const session of active) {
    const label = new Date(session.time.updated).toISOString().slice(0, 10) ===
      new Date().toISOString().slice(0, 10)
      ? "Today"
      : new Date(session.time.updated).toLocaleDateString([], {
          month: "long",
          day: "numeric",
        })
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.sessions.push(session)
    else groups.push({ label, sessions: [session] })
  }

  return (
    <>
      {!open && <div className="sidebar-edge" onPointerDown={(e) => begin(e, "edge")} />}
      {(open || dragX !== null) && (
        <div
          className="scrim"
          style={
            dragX !== null
              ? { opacity: Math.max(0, 1 + dragX / (asideRef.current?.offsetWidth ?? 300)) }
              : undefined
          }
          onPointerDown={(e) => begin(e, "scrim")}
        />
      )}
      <aside
        ref={asideRef}
        className={
          "sidebar" +
          (open ? " open" : "") +
          (dragX !== null ? " dragging" : "")
        }
        style={dragX !== null ? { transform: `translateX(${dragX}px)` } : undefined}
        onPointerDown={(e) => begin(e, "drawer")}
        // a horizontal drag ending on a session row must not select it
        onClickCapture={(e) => {
          if (suppressClick.current) {
            e.stopPropagation()
            e.preventDefault()
            suppressClick.current = false
          }
        }}
      >
        <div className="sidebar-top">
          <button className="new-session" onClick={onCreate}>
            <span className="new-icon">＋</span> New session
          </button>
        </div>
        <nav className="session-list">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="group-label">{group.label}</div>
              {group.sessions.map((session) => (
                <div
                  key={session.id}
                  className={
                    "session-item" + (session.id === activeId ? " active" : "")
                  }
                  onClick={() => onSelect(session.id)}
                >
                  <span className="session-title">
                    {session.title || "Untitled"}
                  </span>
                  <button
                    className="session-delete"
                    title="Archive"
                    aria-label="Archive session"
                    onClick={(e) => {
                      e.stopPropagation()
                      onArchive(session.id)
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))}
          {active.length === 0 && (
            <div className="sidebar-empty">No sessions yet</div>
          )}

          {archived.length > 0 && (
            <>
              <button
                className="archived-toggle"
                onClick={() => setShowArchived(!showArchived)}
              >
                <span>Archived</span>
                <span className="archived-count">{archived.length}</span>
                <span className="tool-caret">{showArchived ? "▾" : "▸"}</span>
              </button>
              {showArchived &&
                archived.map((session) => (
                  <div
                    key={session.id}
                    className="session-item archived"
                    title="Restore"
                    onClick={() => onRestore(session.id)}
                  >
                    <span className="session-title">
                      {session.title || "Untitled"}
                    </span>
                    <button
                      className="session-delete"
                      title="Delete forever"
                      aria-label="Delete session forever"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDeleteForever(session.id)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
            </>
          )}
        </nav>
      </aside>
    </>
  )
}

/* ---------- confirm dialog ---------- */

export type ConfirmRequest = {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  action: () => void
}

export function ConfirmDialog({
  request,
  onCancel,
}: {
  request: ConfirmRequest | null
  onCancel: () => void
}) {
  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [request, onCancel])

  if (!request) return null
  return (
    <>
      <div className="scrim-high" onClick={onCancel} />
      <div className="confirm-host" role="alertdialog" aria-modal="true" aria-label={request.title}>
        <div className="confirm-card">
          <h3>{request.title}</h3>
          <p>{request.message}</p>
          <div className="form-actions">
            <button className="btn-ghost" onClick={onCancel}>
              Cancel
            </button>
            <button
              className={"btn-primary" + (request.danger ? " danger" : "")}
              onClick={() => {
                request.action() // may be async — it runs on; the dialog closes now
                onCancel()
              }}
            >
              {request.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}