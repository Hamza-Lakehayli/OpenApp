/*
   Reducer tests for the streamed store: build the chat from incremental
   events exactly as the SSE stream delivers them — out of order, repeated,
   with gaps — and reconcile snapshots without clobbering live content.
*/
import { describe, expect, it, vi } from "vitest"
import type { V2Event } from "@opencode/client"
import {
  createStreamStore,
  newerThan,
  type Pending,
  type StoredMessage,
} from "./stream"

let n = 0
const msgId = (p = "a") => `msg_${p}${++n}`
const sid = () => `ses_${++n}`
const toolId = () => `tool_${++n}`

const ev = (type: string, data: Record<string, unknown>): V2Event =>
  ({ type, data }) as unknown as V2Event

const userEv = (sessionID: string, inboxID: string, text: string, delivery: "steer" | "queue" = "steer") =>
  ev("session.inbox.enqueued", {
    sessionID,
    inboxID,
    item: { type: "user", payload: { text }, delivery },
  })

const deliveredEv = (sessionID: string, inboxID: string) =>
  ev("session.inbox.delivered", { sessionID, inboxID })

const cancelledEv = (sessionID: string, inboxID: string) =>
  ev("session.inbox.cancelled", { sessionID, inboxID })

function textStream(store: ReturnType<typeof createStreamStore>, sessionID: string, messageID: string, chunks: string[], ord = 0) {
  store.apply(ev("session.text.started", { sessionID, assistantMessageID: messageID, ordinal: ord }))
  for (const c of chunks) {
    store.apply(ev("session.text.delta", { sessionID, assistantMessageID: messageID, ordinal: ord, delta: c }))
  }
  store.apply(ev("session.text.ended", { sessionID, assistantMessageID: messageID, ordinal: ord }))
}

/** the assistant skeleton the app itself would fetch/snapshot in */
const skeleton = (id: string, content: StoredMessage["content"] = []): StoredMessage => ({
  id,
  type: "assistant",
  time: { created: Date.now() },
  content,
})

describe("text accumulation", () => {
  it("builds ordered text within one message from started/delta events", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    textStream(s, sessionID, mid, ["Hello", " world", "!"])
    const m = s.messages(sessionID)[0]
    expect(m.content).toHaveLength(1)
    expect((m.content[0] as { text: string }).text).toBe("Hello world!")
  })

  it("keeps two text blocks apart by ordinal", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    textStream(s, sessionID, mid, ["first"], 0)
    textStream(s, sessionID, mid, ["second"], 1)
    const m = s.messages(sessionID)[0]
    expect(m.content).toHaveLength(2)
    expect((m.content[0] as { text: string }).text).toBe("first")
    expect((m.content[1] as { text: string }).text).toBe("second")
  })

  it("survives a delta arriving before its started event", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    s.apply(ev("session.text.delta", { sessionID, assistantMessageID: mid, ordinal: 0, delta: "early" }))
    const m = s.messages(sessionID)[0]
    expect((m.content[0] as { text: string }).text).toBe("early")
  })

  it("does not duplicate a block when started repeats", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    s.apply(ev("session.text.started", { sessionID, assistantMessageID: mid, ordinal: 0 }))
    s.apply(ev("session.text.started", { sessionID, assistantMessageID: mid, ordinal: 0 }))
    textStream(s, sessionID, mid, ["x"])
    expect(s.messages(sessionID)[0].content).toHaveLength(1)
  })

  it("accumulates reasoning in its own parts", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    s.apply(ev("session.reasoning.started", { sessionID, assistantMessageID: mid, ordinal: 0 }))
    s.apply(ev("session.reasoning.delta", { sessionID, assistantMessageID: mid, ordinal: 0, delta: "think" }))
    const m = s.messages(sessionID)[0]
    expect(m.content).toHaveLength(1)
    expect((m.content[0] as { type: string }).type).toBe("reasoning")
  })
})

describe("tool lifecycle", () => {
  it("runs pending → running → completed and holds the output", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    const tid = toolId()
    s.apply(ev("session.tool.input.started", { sessionID, assistantMessageID: mid, id: tid, name: "read" }))
    s.apply(ev("session.tool.input.ended", { sessionID, assistantMessageID: mid, id: tid, input: { file: "a.ts" } }))
    s.apply(ev("session.tool.called", { sessionID, assistantMessageID: mid, id: tid, input: { file: "a.ts" }, executed: true, name: "read" }))
    s.apply(ev("session.tool.progress", { sessionID, assistantMessageID: mid, id: tid, metadata: { lines: 3 } }))
    s.apply(ev("session.tool.success", { sessionID, assistantMessageID: mid, id: tid, metadata: {}, content: [{ type: "text", text: "ok" }] }))
    const part = s.messages(sessionID)[0].content[0] as {
      id: string
      name: string
      state: { status: string; input: unknown; content?: unknown; metadata?: unknown }
    }
    expect(part.id).toBe(tid)
    expect(part.name).toBe("read")
    expect(part.state.status).toBe("completed")
    expect(part.state.input).toEqual({ file: "a.ts" })
    expect(part.state.content).toEqual([{ type: "text", text: "ok" }])
    expect(part.state.metadata).toEqual({})
  })

  it("marks errors and keeps input", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    const tid = toolId()
    s.apply(ev("session.tool.called", { sessionID, assistantMessageID: mid, id: tid, name: "bash", input: { cmd: "rm" }, executed: true }))
    s.apply(ev("session.tool.failed", { sessionID, assistantMessageID: mid, id: tid, error: { message: "denied" } }))
    const part = s.messages(sessionID)[0].content[0] as {
      name: string
      state: { status: string; input: unknown; error?: unknown }
    }
    expect(part.state.status).toBe("error")
    expect((part.state.error as { message: string }).message).toBe("denied")
    expect(part.state.input).toEqual({ cmd: "rm" })
  })

  it("keys tool parts by tool id, not ordinal guesswork", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    const t1 = toolId()
    const t2 = toolId()
    s.apply(ev("session.tool.called", { sessionID, assistantMessageID: mid, id: t1, name: "read", input: {}, executed: true }))
    s.apply(ev("session.tool.called", { sessionID, assistantMessageID: mid, id: t2, name: "read", input: {}, executed: true }))
    s.apply(ev("session.tool.success", { sessionID, assistantMessageID: mid, id: t2, content: [{ type: "text", text: "two" }] }))
    const parts = s.messages(sessionID)[0].content as Array<{ id: string; state: { status: string } }>
    expect(parts).toHaveLength(2)
    expect(parts.find((p) => p.id === t1)!.state.status).toBe("running")
    expect(parts.find((p) => p.id === t2)!.state.status).toBe("completed")
  })
})

describe("steps and failures", () => {
  it("synthesizes the skeleton from step.started alone (no prior snapshot)", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = msgId("new")
    s.apply(ev("session.step.started", {
      sessionID,
      assistantMessageID: mid,
      started: 25,
      agent: "build",
      model: { id: "gpt", providerID: "openai" },
    }))
    const [m] = s.messages(sessionID)
    expect(m.id).toBe(mid)
    expect(m.agent).toBe("build")
    expect(m.model).toEqual({ id: "gpt", providerID: "openai" })
    expect(m.time.created).toBe(25)
  })

  it("records step tokens, cost and finish", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    s.apply(ev("session.step.ended", { sessionID, assistantMessageID: mid, finish: "stop", tokens: { in: 1 }, cost: 0.5 }))
    const m = s.messages(sessionID)[0]
    expect(m.finish).toBe("stop")
    expect(m.cost).toBe(0.5)
  })

  it("flags a gap when events reference an unknown message", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const onGap = vi.fn()
    s.onGap = onGap
    s.apply(ev("session.text.delta", { sessionID, assistantMessageID: msgId("ghost"), ordinal: 0, delta: "?" }))
    expect(onGap).toHaveBeenCalledWith(sessionID)
  })

  it("step.failed persists the error on the message", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    s.apply(ev("session.step.failed", { sessionID, assistantMessageID: mid, error: { type: "provider.rate-limit", message: "429" } }))
    const m = s.messages(sessionID)[0]
    expect(m.error).toEqual({ type: "provider.rate-limit", message: "429" })
    expect(m.time.completed).toBeTruthy()
  })
})

describe("snapshot reconciliation", () => {
  it("a thinner snapshot never clobbers streamed text", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    textStream(s, sessionID, mid, ["streamed", " content"])
    s.snapshot(sessionID, [skeleton(mid)])
    const m = s.messages(sessionID)[0]
    expect((m.content[0] as { text: string }).text).toBe("streamed content")
  })

  it("a thicker snapshot refreshes a paused view", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    s.snapshot(sessionID, [{ ...skeleton(mid), content: [{ type: "text", text: "complete answer" }] }])
    const m = s.messages(sessionID)[0]
    expect((m.content[0] as { text: string }).text).toBe("complete answer")
  })

  it("removes a gone message only once it is terminal", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const live = { ...skeleton(msgId("live")) }
    const done = { ...skeleton(msgId("done")), time: { created: 1, completed: 2 } }
    s.snapshot(sessionID, [live, done])
    // both vanish from the server list
    s.snapshot(sessionID, [])
    const ids = s.messages(sessionID).map((m) => m.id)
    expect(ids).toContain(live.id) // still streaming here → keep
    expect(ids).not.toContain(done.id) // terminal and absent → drop
  })

  it("sweeps the optimistic bubble once its real message lands", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = msgId("p")
    s.pending({ id: mid, sessionID, text: "hello", status: "steering", delivery: "steer", time: 1 })
    expect(s.pendings(sessionID)).toHaveLength(1)
    s.snapshot(sessionID, [{ id: mid, type: "user", time: { created: 2 }, content: [] } as unknown as StoredMessage])
    expect(s.pendings(sessionID)).toHaveLength(0)
    expect(s.messages(sessionID)).toHaveLength(1)
  })
})

describe("pending prompts", () => {
  it("refines status through enqueued → delivered", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = msgId("q")
    s.pending({ id: mid, sessionID, text: "go", status: "sending", delivery: "steer", time: 1 })
    s.apply(userEv(sessionID, mid, "go"))
    expect(s.pendings(sessionID)[0].status).toBe("steering")
    s.apply(deliveredEv(sessionID, mid))
    expect(s.pendings(sessionID)[0].status).toBe("delivered")
  })

  it("adopts prompts enqueued from other clients", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const oid = msgId("other")
    s.apply(userEv(sessionID, oid, "from the desktop", "queue"))
    const [p] = s.pendings(sessionID)
    expect(p.id).toBe(oid)
    expect(p.text).toBe("from the desktop")
    expect(p.status).toBe("queued")
  })

  it("drops a pending when it is cancelled", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = msgId("c")
    s.pending({ id: mid, sessionID, text: "x", status: "steering", delivery: "steer", time: 1 })
    s.apply(cancelledEv(sessionID, mid))
    expect(s.pendings(sessionID)).toHaveLength(0)
  })

  it("adopts the same status from inbox listing (reconnect path)", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = msgId("i")
    s.pending({ id: mid, sessionID, text: "again", status: "unknown", delivery: "steer", time: 1 })
    s.adoptInbox(sessionID, [{ id: mid, type: "user", payload: { text: "again" }, delivery: "queue" }])
    expect(s.pendings(sessionID)[0].status).toBe("queued")
  })

  it("ignores non-user inbox items and non-user payloads", () => {
    const s = createStreamStore()
    const sessionID = sid()
    s.adoptInbox(sessionID, [{ id: msgId("syn"), type: "synthetic", payload: { text: "..." }, delivery: "steer" }])
    expect(s.pendings(sessionID)).toHaveLength(0)
  })
})

describe("listener batching", () => {
  it("notifies once per affected session", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const seen: Array<Set<string>> = []
    s.subscribe((dirty) => seen.push(dirty))
    seen.length = 0 // drop the immediate subscription callback
    const mid = skeleton(msgId()).id
    s.snapshot(sessionID, [skeleton(mid)])
    textStream(s, sessionID, mid, ["1", "2"])
    // rAF is absent in node → flushes are synchronous: content events each fire
    expect(seen.length).toBeGreaterThan(2)
    for (const batch of seen) expect(batch.has(sessionID)).toBe(true)
  })
})

describe("newerThan merge rule", () => {
  it("compares content volume then error carrying", () => {
    const short = skeleton(msgId(), [{ type: "text", text: "ab" }])
    const longA = { ...skeleton(msgId(), [{ type: "text", text: "abc" }]) }
    expect(newerThan(longA, short)).toBe(true)
    expect(newerThan(short, longA)).toBe(false)
    expect(newerThan(short, short)).toBe(false)
    const withErr = { ...skeleton(msgId(), [{ type: "text", text: "ab" }]), error: { type: "unknown" } }
    expect(newerThan(withErr, short)).toBe(true)
    expect(newerThan(short, withErr)).toBe(false)
  })
})

describe("overlapping sends", () => {
  it("identical prompts reuse the same pending entry (id is the key)", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = msgId("same")
    const base: Pending = { id: mid, sessionID, text: "same", status: "sending", delivery: "steer", time: 1 }
    s.pending(base)
    s.pending({ ...base, time: 2 })
    s.pendingStatus(mid, "delivered")
    expect(s.pendings(sessionID)).toHaveLength(1)
    expect(s.pendings(sessionID)[0].time).toBe(2)
  })

  it("two sends to the same session stay separate bubbles", () => {
    const s = createStreamStore()
    const sessionID = sid()
    s.pending({ id: msgId("one"), sessionID, text: "one", status: "sending", delivery: "steer", time: 1 })
    s.pending({ id: msgId("two"), sessionID, text: "two", status: "steering", delivery: "steer", time: 2 })
    expect(s.pendings(sessionID)).toHaveLength(2)
  })

  it("statuses never leak across sessions", () => {
    const s = createStreamStore()
    const a = sid()
    const b = sid()
    const idA = msgId("a")
    s.pending({ id: idA, sessionID: a, text: "a", status: "sending", delivery: "steer", time: 1 })
    s.apply(deliveredEv(b, idA))
    expect(s.pendings(a)[0].status).toBe("sending")
    expect(s.pendings(b)).toHaveLength(0)
  })

  it("unknown sends keep their bubble visible (never disappear silently)", () => {
    const s = createStreamStore()
    const sessionID = sid()
    const mid = msgId("u")
    s.pending({ id: mid, sessionID, text: "was this received?", status: "unknown", delivery: "steer", time: 1 })
    s.snapshot(sessionID, []) // a snapshot without the message does NOT drop it
    expect(s.pendings(sessionID)).toHaveLength(1)
    expect(s.pendings(sessionID)[0].status).toBe("unknown")
  })
})
