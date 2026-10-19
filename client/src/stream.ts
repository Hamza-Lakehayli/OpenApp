/**
 * stream.ts — the live message store.
 *
 * Replaces per-delta full-history reloads with an incremental reducer:
 * normalized per-session message state keyed by server message ID, updated
 * from the SSE event stream, committed to React in animation-frame batches.
 *
 * Sent prompts get a client-generated `msg_` id (validated: the server
 * requires the prefix) that is reused as the optimistic bubble, the inbox
 * item id, the user message id, and any retry id — verified on a 2.0.27
 * server: inboxID === prompt id === user message id.
 */
import type { V2Event } from "@opencode/client"

export type PromptStatus =
  | "sending" // POST in flight
  | "steering" // admitted, applies at next step boundary
  | "queued" // admitted as queue-mode
  | "delivered" // session.inbox.delivered seen
  | "failed" // never admitted (or inbox.cancelled)
  | "unknown" // transport died mid-send; still reconciling

export type Pending = {
  id: string
  sessionID: string
  text: string
  status: PromptStatus
  delivery: "steer" | "queue"
  time: number
}

/** Raw server-shaped message, mutated in place by events. */
export type StoredMessage = {
  id: string
  type: "user" | "assistant" | "system" | "synthetic"
  time: { created: number; streamed?: number; completed?: number }
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  content: unknown[]
  error?: unknown
  finish?: string
  tokens?: unknown
  cost?: number
}

type ToolPart = {
  type: "tool"
  id: string
  name: string
  executed: boolean
  state: {
    status: "pending" | "running" | "completed" | "error"
    input: unknown
    content?: unknown
    error?: unknown
    metadata?: unknown
  }
  time?: { created: number; ran?: number; completed?: number }
}

type TextPart = { type: "text"; ordinal?: number; text: string }
type ReasoningPart = { type: "reasoning"; ordinal?: number; text: string }

export type Listener = (sessionIDs: Set<string>) => void

export interface StreamStore {
  /** Replace normalized state from a message.list fetch. */
  snapshot(sessionID: string, list: StoredMessage[]): void
  /** Feed one SSE event through the reducer. Returns affected sessionIDs. */
  apply(event: V2Event): Set<string>
  /** Set by the app: an event referenced an unknown message — reconcile. */
  onGap?: (sessionID: string) => void
  /** Record a client-side send (optimistic bubble). */
  pending(p: Pending): void
  /** Current pending items for a session. */
  pendings(sessionID: string): Pending[]
  /** Update one pending status (inbox events, transport failures). */
  pendingStatus(id: string, status: PromptStatus): void
  /** List the inbox (server) and adopt user items as pending. */
  adoptInbox(sessionID: string, items: unknown): void
  /** Drop pending items whose id exists as a real message (delivery landed). */
  sweep(sessionID: string): void
  /** Current messages of a session, ordered by creation time. */
  messages(sessionID: string): StoredMessage[]
  /** Subscribe; first callback fires on subscribe (bundled to a fresh listener). */
  subscribe(l: Listener): () => void
  /** Raw storage for tests. */
  _clear(): void
}

/** True when a would REPLACE b without losing streamed content. */
export function newerThan(a: unknown, b: unknown): boolean {
  const left = a as { content?: unknown[]; time?: { completed?: number }; error?: unknown }
  const right = b as { content?: unknown[]; time?: { completed?: number }; error?: unknown }
  const textOf = (m: { content?: unknown[] }) =>
    (m?.content ?? [])
      .filter((p) => (p as { text?: string }).text != null)
      .reduce((n: number, p) => n + String((p as { text: string }).text).length, 0)
  const l = textOf(left)
  const r = b != null ? textOf(right) : 0
  if (l > r) return true
  if (l < r) return false
  const lc = left?.time?.completed ?? 0
  const rc = right?.time?.completed ?? 0
  if (lc === rc) return left?.error != null && right?.error == null
  return false
}

export function createStreamStore(): StreamStore {
  const sessions = new Map<string, Map<string, StoredMessage>>()
  const pendingMap = new Map<string, Pending>()
  const listeners = new Set<Listener>()
  /** per-session monotonic counter for gap detection bookkeeping */
  const revs = new Map<string, number>()
  const dirty = new Set<string>()
  let frame: number | null = null

  const bump = (sid: string) => revs.set(sid, (revs.get(sid) ?? 0) + 1)

  function flush() {
    frame = null
    if (dirty.size === 0) return
    const batch = new Set(dirty)
    dirty.clear()
    for (const l of listeners) l(batch)
  }

  const schedule = (sid: string) => {
    dirty.add(sid)
    if (frame == null && typeof requestAnimationFrame === "function") {
      frame = requestAnimationFrame(flush)
    } else if (frame == null) {
      // test / non-DOM environment: settle synchronously
      flush()
    }
  }

  const map = (sid: string) => {
    let m = sessions.get(sid)
    if (!m) {
      m = new Map()
      sessions.set(sid, m)
    }
    return m
  }

  const store: StreamStore = {
    snapshot(sessionID: string, list: StoredMessage[]) {
      const m = map(sessionID)
      let changed = false
      const incoming = new Map(list.map((x) => [x.id, x]))
      for (const [id, cur] of [...m]) {
        // drop ids the server no longer lists — but never live content: a
        // message missing from a stale list may still be streaming here
        if (!incoming.has(id) && (cur.time?.completed || cur.error)) {
          m.delete(id)
          changed = true
        }
      }
      for (const [id, next] of incoming) {
        const cur = m.get(id)
        if (!cur || newerThan(next, cur)) {
          m.set(id, next)
          changed = true
        }
      }
      store.sweep(sessionID)
      if (changed) schedule(sessionID)
      return changed
    },

    apply(event: V2Event): Set<string> {
      const type = event.type as string
      const d = (event as { data?: Record<string, unknown> }).data ?? {}
      const sid = d.sessionID as string | undefined
      const out = new Set<string>()
      if (!sid || !type.startsWith("session.")) return out

      if (type.startsWith("session.inbox.")) {
        const inboxID = d.inboxID as string | undefined
        if (type !== "session.inbox.enqueued" && !inboxID) return out
        // never touch a pending owned by another session (ids are global)
        const own = inboxID ? (pendingMap.get(inboxID)?.sessionID === sid ? pendingMap.get(inboxID) : undefined) : undefined
        if (type === "session.inbox.enqueued") {
          const item = d.item as { type?: string; payload?: { text?: string }; delivery?: "steer" | "queue" } | undefined
          if (item?.type === "user") {
            const delivery = item.delivery ?? "steer"
            if (own) {
              own.status = delivery === "queue" ? "queued" : "steering"
            } else if (inboxID && !pendingMap.has(inboxID)) {
              // another client (TUI) enqueued something — surface it too
              pendingMap.set(inboxID, {
                id: inboxID,
                sessionID: sid,
                text: item.payload?.text ?? "",
                status: delivery === "queue" ? "queued" : "steering",
                delivery,
                time: Date.now(),
              })
            }
          }
        } else if (type === "session.inbox.delivery.changed") {
          const delivery = d.delivery as "steer" | "queue" | undefined
          if (own && delivery) own.status = delivery === "queue" ? "queued" : "steering"
        } else if (type === "session.inbox.delivered") {
          if (own) own.status = "delivered"
        } else if (type === "session.inbox.cancelled") {
          if (own) {
            // the user cancelled elsewhere; the bubble is gone either way
            pendingMap.delete(inboxID!)
          }
        }
        out.add(sid)
        schedule(sid)
        return out
      }

      const mid = (d.assistantMessageID ?? d.id) as string | undefined

      if (type === "session.step.started") {
        const m = map(sid)
        if (mid && !m.has(mid)) {
          m.set(mid, {
            id: mid,
            type: "assistant",
            time: { created: (d.started as number) || Date.now() },
            agent: d.agent as string | undefined,
            model: d.model as StoredMessage["model"],
            content: [],
          })
          out.add(sid)
          schedule(sid)
        }
        return out
      }

      if (mid) bump(sid)
      const m = mid ? map(sid).get(mid) : undefined
      if (!m && mid && (type.startsWith("session.text.") || type.startsWith("session.reasoning.") || type.startsWith("session.tool.") || type.startsWith("session.step."))) {
        // event for an unknown message — reducer gap; caller reconciles
        out.add(sid)
        store.onGap?.(sid)
        return out
      }
      if (!m) return out
      out.add(sid)

      switch (type) {
        case "session.text.started":
        case "session.reasoning.started": {
          const kind = type === "session.text.started" ? "text" : "reasoning"
          const ord = (d.ordinal as number) ?? m.content.length
          const exists = m.content.some(
            (p) =>
              (p as { type?: string }).type === kind &&
              ((p as { ordinal?: number }).ordinal ?? 0) === ord,
          )
          if (!exists) m.content.push({ type: kind, ordinal: ord, text: "" } as TextPart)
          break
        }
        case "session.text.delta":
        case "session.reasoning.delta": {
          const ord = (d.ordinal as number) ?? 0
          const part = m.content.find(
            (p) =>
              ((p as TextPart).type === "text") === type.startsWith("session.text.") &&
              ((p as { ordinal?: number }).ordinal ?? 0) === ord,
          ) as TextPart | ReasoningPart | undefined
          if (!part) {
            m.content.push({ type: type.startsWith("session.text.") ? "text" : "reasoning", ordinal: ord, text: (d.delta as string) ?? "" } as TextPart)
          } else {
            part.text += (d.delta as string) ?? ""
          }
          break
        }
        case "session.text.ended":
        case "session.reasoning.ended":
          break // text already accumulated
        case "session.step.streamed":
          m.time.streamed = Date.now()
          break
        case "session.step.ended": {
          m.finish = (d.finish as string) ?? m.finish
          m.tokens = d.tokens ?? m.tokens
          m.cost = (d.cost as number) ?? m.cost
          if (!m.time.completed && d.finish && d.finish !== "tool-calls" && d.finish !== "tool_calls") {
            m.time.completed = Date.now()
          }
          break
        }
        case "session.step.failed": {
          m.error = d.error ?? m.error
          m.time.completed = m.time.completed ?? Date.now()
          break
        }
        case "session.tool.input.started":
        case "session.tool.called": {
          const tid = d.id as string
          const ord = (d.ordinal as number) ?? m.content.length
          let part = m.content.find((p) => (p as ToolPart).id === tid) as ToolPart | undefined
          if (!part) {
            part = {
              type: "tool",
              id: tid,
              name: (d.name as string) ?? "",
              executed: type === "session.tool.called" ? Boolean(d.executed) : false,
              state: { status: type === "session.tool.called" ? "running" : "pending", input: d.input ?? null },
              time: { created: Date.now() },
            } as ToolPart
            ;(part as { ordinal?: number }).ordinal = ord
            m.content.push(part)
          } else {
            if (d.input != null) part.state.input = d.input
            if (type === "session.tool.called") {
              part.state.status = "running"
              if (d.name) part.name = d.name as string
            }
          }
          break
        }
        case "session.tool.input.ended": {
          const part = m.content.find((p) => (p as ToolPart).id === (d.id as string)) as ToolPart | undefined
          if (part && d.input != null) part.state.input = d.input
          break
        }
        case "session.tool.progress": {
          const part = m.content.find((p) => (p as ToolPart).id === (d.id as string)) as ToolPart | undefined
          if (part) part.state.metadata = d.metadata ?? part.state.metadata
          break
        }
        case "session.tool.success": {
          const part = m.content.find((p) => (p as ToolPart).id === (d.id as string)) as ToolPart | undefined
          if (part) {
            part.state.status = "completed"
            part.state.content = d.content ?? part.state.content
            if (d.metadata != null) part.state.metadata = d.metadata
            part.time = { ...(part.time ?? { created: Date.now() }), completed: Date.now() }
            if (!part.name && (d as { name?: string }).name) part.name = (d as { name?: string }).name!
          }
          break
        }
        case "session.tool.failed": {
          const part = m.content.find((p) => (p as ToolPart).id === (d.id as string)) as ToolPart | undefined
          if (part) {
            part.state.status = "error"
            part.state.error = d.error
            if (d.content != null) part.state.content = d.content
            part.time = { ...(part.time ?? { created: Date.now() }), completed: Date.now() }
          }
          break
        }
        default:
          break
      }
      schedule(sid)
      return out
    },

    pending(p: Pending) {
      pendingMap.set(p.id, p)
      schedule(p.sessionID)
    },

    pendings(sessionID: string) {
      return [...pendingMap.values()].filter((p) => p.sessionID === sessionID)
    },

    pendingStatus(id: string, status: PromptStatus) {
      const p = pendingMap.get(id)
      if (!p) return
      p.status = status
      schedule(p.sessionID)
    },

    adoptInbox(sessionID: string, items: unknown) {
      const arr = Array.isArray(items) ? items : []
      for (const it of arr) {
        const info = it as { id?: string; type?: string; payload?: { text?: string }; delivery?: "steer" | "queue" }
        if (!info.id || info.type !== "user") continue
        if (map(sessionID).has(info.id)) continue
        const existing = pendingMap.get(info.id)
        const delivery = info.delivery ?? "steer"
        if (existing) {
          existing.status = delivery === "queue" ? "queued" : "steering"
        } else {
          pendingMap.set(info.id, {
            id: info.id,
            sessionID,
            text: info.payload?.text ?? "",
            status: delivery === "queue" ? "queued" : "steering",
            delivery,
            time: Date.now(),
          })
        }
      }
      schedule(sessionID)
    },

    sweep(sessionID: string) {
      const m = map(sessionID)
      for (const [id, p] of [...pendingMap]) {
        if (p.sessionID !== sessionID) continue
        if (m.has(id)) {
          if (p.status !== "delivered") {
            p.status = "delivered"
          }
          pendingMap.delete(id)
          dirty.add(sessionID)
        }
      }
    },

    messages(sessionID: string) {
      const m = sessions.get(sessionID)
      return m ? [...m.values()].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0)) : []
    },

    subscribe(l: Listener) {
      listeners.add(l)
      // one immediate callback so a new subscriber renders current state
      l(new Set(sessions.keys()))
      return () => listeners.delete(l)
    },

    _clear() {
      sessions.clear()
      pendingMap.clear()
      revs.clear()
      dirty.clear()
      listeners.clear()
    },
  }
  return store
}

export const store = createStreamStore()
