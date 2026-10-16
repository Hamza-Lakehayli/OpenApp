import type {
  SessionMessageInfo,
  SessionMessageAssistant,
  SessionMessageAssistantText,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantTool,
  SessionInfo,
  ModelInfo,
  AgentInfo,
  ModelRef,
  V2Event,
} from "@opencode/client"

export type { SessionInfo, ModelInfo, AgentInfo, ModelRef, V2Event }

export type AgentOption = { id: string; name: string; description?: string }

export type ChatItem =
  | { kind: "user"; id: string; text: string; time: number }
  | { kind: "system"; id: string; text: string; time: number }
  | {
      kind: "assistant"
      id: string
      time: number
      agent: string
      model?: string
      blocks: Block[]
      error?: ErrorInfo
      done: boolean
    }

/** A failure the server attached to a turn: inference, provider, or abort. */
export type ErrorInfo = {
  kind: "error" | "interrupted"
  title: string
  detail?: string
}

/** A live banner for the open session: a failed step or an active retry. */
export type SessionNotice = {
  kind: "error" | "retry" | "interrupted"
  title: string
  detail?: string
  attempt?: number
  next?: number
}

/**
 * Humanize the server's error object (`{ type, message, status?, response? }`).
 * Verified against a 2.0.22 server: provider failures carry
 * `type: "provider.auth"` plus an HTTP status and raw response body.
 */
export function describeError(raw: unknown): ErrorInfo {
  const e = (raw ?? {}) as {
    type?: string
    message?: string
    status?: number
    response?: { body?: string }
  }
  const type = e.type || "error"
  if (type === "aborted")
    return { kind: "interrupted", title: "Interrupted" }
  const titles: Record<string, string> = {
    "provider.auth": "Provider auth error",
    "provider.rate-limit": "Provider rate limit",
    "provider.rate_limit": "Provider rate limit",
    "provider.quota": "Provider quota exceeded",
    "provider.content-filter": "Content filter",
    "provider.transport": "Provider connection error",
    "provider.internal": "Provider internal error",
    "provider.invalid-output": "Invalid provider output",
    "provider.invalid-request": "Invalid request",
    "provider.unsupported-operation": "Unsupported operation",
    "provider.no-route": "Provider unreachable",
    "provider.unknown": "Provider error",
    "provider.timeout": "Provider timeout",
    "permission.rejected": "Permission rejected",
    "tool.execution": "Tool failed",
    "unknown": "Error",
  }
  const title = titles[type] ?? type.replace(/[._]/g, " ")
  const bits: string[] = []
  if (typeof e.status === "number") bits.push(`HTTP ${e.status}`)
  if (e.message) bits.push(e.message)
  let detail = bits.join(" — ")
  const body = e.response?.body
  if (body && body.trim()) {
    const snippet = body.trim().replace(/\s+/g, " ")
    detail += (detail ? "\n" : "") + snippet.slice(0, 300) + (snippet.length > 300 ? "…" : "")
  }
  return { kind: "error", title, ...(detail ? { detail } : {}) }
}

export type Block =
  | { type: "text"; ordinal: number; text: string }
  | { type: "reasoning"; ordinal: number; text: string }
  | {
      type: "tool"
      ordinal: number
      toolId: string
      name: string
      state: string
      input: string
      output?: string
      images?: Array<{ uri: string; mime?: string }>
    }
  | { type: "document"; ordinal: number; path: string; name: string }

const ordinal = (part: unknown, i: number): number =>
  (part as { ordinal?: number })?.ordinal ?? i

/**
 * Documents the chat surfaces as cards: whenever a write/edit lands one of
 * these, a card with View/Download appears in the flow. Code files stay in
 * the Files panel — only documents push.
 */
const DOCUMENT_PATH = /\.(md|markdown|txt|pdf|docx?|rtf|odt|pptx|xlsx)$/i

/** The document writes of an assistant message: path + part ordinal. */
function documentWritesOf(
  message: SessionMessageAssistant,
): Array<{ path: string; ordinal: number }> {
  const writes: Array<{ path: string; ordinal: number }> = []
  message.content.forEach((part, i) => {
    if (part.type !== "tool") return
    const tool = part as SessionMessageAssistantTool
    if (tool.name !== "write" && tool.name !== "edit") return
    const state = (
      part as { state?: { status?: string; input?: { path?: unknown } } }
    ).state
    if (state?.status !== "completed") return
    const path =
      typeof state.input?.path === "string" ? state.input.path : undefined
    if (!path || !DOCUMENT_PATH.test(path)) return
    writes.push({ path, ordinal: ordinal(part, i) })
  })
  return writes
}

/** Flatten an assistant message's content parts into ordered blocks. */
function blocksOf(message: SessionMessageAssistant): Block[] {
  const blocks: Block[] = []
  message.content.forEach((part, i) => {
    if (part.type === "text") {
      const p = part as SessionMessageAssistantText
      if (p.text)
        blocks.push({ type: "text", ordinal: ordinal(part, i), text: p.text })
    } else if (part.type === "reasoning") {
      const p = part as SessionMessageAssistantReasoning
      if (p.text)
        blocks.push({ type: "reasoning", ordinal: ordinal(part, i), text: p.text })
    } else if (part.type === "tool") {
      blocks.push(toolBlock(part as SessionMessageAssistantTool, ordinal(part, i)))
    }
  })
  return blocks.sort((a, b) => a.ordinal - b.ordinal)
}

/**
 * Extract what the tool dropdown shows: the call's input and its output.
 * The state carries both — `input` is the arguments object, `content` the
 * result's text parts, and an error state carries the failure instead.
 */
function toolBlock(part: SessionMessageAssistantTool, ord: number): Block {
  const state = (
    part as {
      state?: {
        status?: string
        input?: unknown
        content?: unknown
        error?: { message?: string; title?: string }
      }
    }
  ).state
  const status = state?.status ?? "running"

  let input = ""
  if (state?.input && typeof state.input === "object") {
    input = JSON.stringify(state.input, null, 2)
  } else if (state?.input != null) {
    input = String(state.input)
  }

  let output: string | undefined
  const images: Array<{ uri: string; mime?: string }> = []
  if (status === "error") {
    output = state?.error?.message || state?.error?.title || "error"
  } else if (Array.isArray(state?.content)) {
    const texts = (state.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text as string)
    if (texts.length) output = texts.join("\n")
    // screenshots and other file outputs ride as file parts — the uri is a
    // data URI, a URL, or a path the fs API serves
    for (const c of state.content as Array<{ type?: string; uri?: string; mime?: string }>) {
      if (c.type === "file" && c.uri) images.push({ uri: c.uri, mime: c.mime })
    }
  }

  return {
    type: "tool",
    ordinal: ord,
    toolId: part.id,
    name: part.name,
    state: status,
    input,
    output,
    ...(images.length ? { images } : {}),
  }
}

export function modelLabel(message: SessionMessageAssistant): string | undefined {
  const m = message.model
  return m ? `${m.providerID}/${m.id}` : undefined
}

/** Convert the API message stream into the chat items the view renders. */
export function toChatItems(messages: SessionMessageInfo[]): ChatItem[] {
  const items: ChatItem[] = []
  for (const m of messages) {
    if (m.type === "user") {
      const text = (m as { text?: string }).text ?? ""
      if (text.trim())
        items.push({ kind: "user", id: m.id, text, time: m.time.created })
    } else if (m.type === "assistant") {
      const error = (m as { error?: unknown }).error
      const blocks = blocksOf(m)
      // document cards: one per path, positioned at its latest write
      const latest = new Map<string, number>()
      for (const w of documentWritesOf(m)) latest.set(w.path, w.ordinal)
      for (const [path, ord] of latest) {
        blocks.push({
          type: "document",
          ordinal: ord,
          path,
          name: path.split(/[\\/]/).pop() || path,
        })
      }
      blocks.sort((a, b) => a.ordinal - b.ordinal)
      items.push({
        kind: "assistant",
        id: m.id,
        time: m.time.created,
        agent: m.agent,
        model: modelLabel(m),
        blocks,
        error: error ? describeError(error) : undefined,
        done: Boolean(m.time.completed),
      })
    } else if (m.type === "system" || m.type === "synthetic") {
      const text = (m as { text?: string }).text
      const description = (m as { description?: string }).description
      const line = text || description
      if (line?.trim())
        items.push({ kind: "system", id: m.id, text: line, time: m.time.created })
    }
  }
  return items
}

export function timeAgo(ms: number): string {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return "now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}
