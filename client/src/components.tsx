import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type {
  ModelInfo,
  ModelRef,
  SessionInfo,
  ChatItem,
  Block,
  AgentOption,
  ErrorInfo,
  SessionNotice,
} from "./types"
import { Markdown } from "./markdown"
import { client } from "./api"
import { DocumentIcon, XMarkIcon } from "@heroicons/react/20/solid"
import { recentModels } from "./recent"
import { downloadFile, FileViewer, fileNameOf } from "./files"
import { initialConnection } from "./connection"

type TokenShape = {
  input?: number
  output?: number
  reasoning?: number
}

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

/**
 * OpenCode's own hosted models — the ones a fresh install can use with no
 * account, no keys. (Model.cost is tiers at runtime; price-zero is a bad
 * signal — other providers also report 0 — so provider identity is the
 * reliable "free" test.)
 */
export const isFreeModel = (m: ModelInfo) => m.providerID === "opencode"

/*
   Provider logos from the models.dev registry (the same registry OpenCode
   uses — every providerID has a logo slug there). The SVGs are monochrome
   and draw with currentColor; as <img> they'd resolve to black (an <img>
   can't see the page's CSS), so the SVG text is fetched once, sanitized,
   inlined, and tinted with the provider's brand color. Unknown providers
   fall back to the theme's text color; a fetch failure (offline, unknown
   id) renders a colored monogram badge so the row is never empty.
*/
type LogoState = { svg?: string; failed?: boolean }
const logoCache = new Map<string, LogoState>()
const logoWaiters = new Map<string, Promise<LogoState>>()

function loadLogo(provider: string): Promise<LogoState> {
  const hit = logoCache.get(provider)
  if (hit) return Promise.resolve(hit)
  let w = logoWaiters.get(provider)
  if (!w) {
    w = fetch(`https://models.dev/logos/${provider}.svg`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        // belt-and-suspenders sanitizing for injected markup
        let svg = text
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
        // some slugs ship without a fill attribute (defaults to black) —
        // root-level currentColor lets the brand color tint every path
        svg = svg.replace(/<svg([^>]*)>/i, (_m, attrs: string) =>
          /fill=/i.test(attrs) ? `<svg${attrs}>` : `<svg${attrs} fill="currentColor">`,
        )
        const st: LogoState = { svg }
        logoCache.set(provider, st)
        return st
      })
      .catch(() => {
        const st: LogoState = { failed: true }
        logoCache.set(provider, st)
        return st
      })
      .finally(() => {
        logoWaiters.delete(provider)
      })
    logoWaiters.set(provider, w)
  }
  return w
}

/* brand colors — approximations of each provider's official mark; the
   default (theme text) keeps unknown providers monochrome and clean */
const BRAND_COLOR: Record<string, string> = {
  anthropic: "#d97757",
  "claude-code": "#d97757",
  nvidia: "#76b900",
  google: "#4285f4",
  googlegemini: "#4285f4",
  gemini: "#4285f4",
  openai: "#ececec",
  "github-copilot": "#ececec",
  github: "#ececec",
  digitalocean: "#0080ff",
  gitlab: "#fc6d26",
  "amazon-bedrock": "#ff9900",
  azure: "#0078d4",
  deepseek: "#4d6bfe",
  groq: "#f55036",
  mistral: "#ff7000",
  "mistral-ai": "#ff7000",
  snowflake: "#29b5e8",
  poe: "#6b5cff",
  xai: "#ececec",
  qwen: "#615ced",
  meta: "#0866ff",
  perplexity: "#20808d",
}

export function ProviderIcon({
  provider,
  size = 18,
}: {
  provider: string
  size?: number
}) {
  const [state, setState] = useState<LogoState | undefined>(() =>
    logoCache.get(provider),
  )
  useEffect(() => {
    let live = true
    const hit = logoCache.get(provider)
    if (hit) {
      setState(hit)
      return
    }
    setState(undefined)
    void loadLogo(provider).then((st) => {
      if (live) setState(st)
    })
    return () => {
      live = false
    }
  }, [provider])

  if (state?.failed) {
    const letter = (provider || "?").trim().charAt(0).toUpperCase()
    const hue = [...provider].reduce((n, c) => n + c.charCodeAt(0), 0) % 360
    return (
      <span
        className="provider-icn mono"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.55),
          background: `hsl(${hue} 30% 34%)`,
        }}
        aria-hidden="true"
      >
        {letter}
      </span>
    )
  }
  if (!state?.svg) {
    // loading: a quiet placeholder that keeps the row from jumping
    return (
      <span
        className="provider-icn mono"
        style={{ width: size, height: size, background: "var(--surface)" }}
        aria-hidden="true"
      />
    )
  }
  return (
    <span
      className="provider-icn svg"
      style={{
        width: size,
        height: size,
        color: BRAND_COLOR[provider] ?? "var(--text)",
      }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  )
}

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
  const free = rest.filter(isFreeModel)
  const paid = rest.filter((m) => !free.includes(m))

  const renderItem = (m: ModelInfo) => (
    <button
      key={`${m.providerID}/${m.id}`}
      className={"picker-item has-icn" + (isCurrent(m) ? " selected" : "")}
      onClick={() => {
        onPick(m)
        setOpen(false)
      }}
    >
      <ProviderIcon provider={m.providerID} size={18} />
      <span className="picker-item-body">
        <span className="picker-item-name">{m.name}</span>
        <span className="picker-item-provider">{m.providerID}</span>
      </span>
    </button>
  )

  return (
    <div className="picker" ref={ref}>
      <button className="picker-btn" onClick={() => setOpen(!open)}>
        {current && <ProviderIcon provider={current.providerID} size={14} />}
        {label}
        <span className="picker-caret">▾</span>
      </button>
      {open && (
        <div className="picker-menu">
          {recent.length > 0 && (
            <div className="picker-group-label">Recently used</div>
          )}
          {recent.map(renderItem)}
          {free.length > 0 && (
            <div className="picker-group-label">Free · no account</div>
          )}
          {free.map(renderItem)}
          {paid.length > 0 && (free.length > 0 || recent.length > 0) && (
            <div className="picker-group-label">All models</div>
          )}
          {paid.map(renderItem)}
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

/*
   A screenshot or other file output: the uri is a data URI, a URL, or a path
   on the desktop the fs API serves. data:/http(s) render directly; a path
   fetches its bytes through client.file.read.
*/
function ToolImage({
  uri,
  mime,
  sessionDirectory,
}: {
  uri: string
  mime?: string
  sessionDirectory?: string
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState(false)

  useEffect(() => {
    let cancelled = false
    let revoke: string | undefined
    const load = async () => {
      try {
        if (uri.startsWith("data:") || /^https?:\/\//.test(uri)) {
          if (!cancelled) setSrc(uri)
          return
        }
        const location = sessionDirectory
          ? { location: { directory: sessionDirectory } }
          : undefined
        const bytes = await client.file.read({
          path: uri,
          ...(location ?? {}),
        } as never)
        const blob = new Blob([bytes as unknown as BlobPart], {
          type: mime || "image/png",
        })
        const url = URL.createObjectURL(blob)
        revoke = url
        if (!cancelled) setSrc(url)
      } catch {
        if (!cancelled) setFailed(true)
      }
    }
    void load()
    return () => {
      cancelled = true
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [uri, mime, sessionDirectory])

  // Esc dismisses the lightbox
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoom(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [zoom])

  if (failed) return null
  if (!src) return <div className="tool-image-loading">screenshot…</div>
  const alt = uri.split(/[\\/]/).pop() || "screenshot"
  return (
    <>
      <img
        className="tool-image clickable"
        src={src}
        alt={alt}
        title="Tap to enlarge"
        onClick={() => setZoom(true)}
      />
      {zoom && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={() => setZoom(false)}
        >
          <button className="lightbox-close" aria-label="Close" onClick={() => setZoom(false)}>
            <XMarkIcon />
          </button>
          <img className="lightbox-img" src={src} alt={alt} />
        </div>
      )}
    </>
  )
}

function ToolBlock({
  block,
  sessionDirectory,
}: {
  block: ToolBlockData
  sessionDirectory?: string
}) {
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
      {block.images && (
        <div className="tool-images">
          {block.images.map((img, i) => (
            <ToolImage
              key={`${img.uri.slice(0, 40)}-${i}`}
              uri={img.uri}
              mime={img.mime}
              sessionDirectory={sessionDirectory}
            />
          ))}
        </div>
      )}
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

/* ---------- document card: a document the agent just wrote ---------- */

function DocumentCard({
  block,
  sessionDirectory,
}: {
  block: Extract<Block, { type: "document" }>
  sessionDirectory?: string
}) {
  const [viewer, setViewer] = useState(false)
  return (
    <div className="doc-card">
      <span className="doc-icon" aria-hidden="true">
        <DocumentIcon />
      </span>
      <span className="doc-card-name">{block.name}</span>
      <div className="doc-card-actions">
        <button className="btn-ghost" onClick={() => setViewer(true)}>
          View
        </button>
        <button
          className="btn-ghost"
          onClick={() => downloadFile(block.path, sessionDirectory)}
        >
          Download
        </button>
      </div>
      {viewer && (
        <FileViewer
          path={block.path}
          name={block.name}
          sessionDirectory={sessionDirectory}
          onClose={() => setViewer(false)}
        />
      )}
    </div>
  )
}

export function ChatView({
  items,
  streaming,
  sessionDirectory,
  onRetry,
}: {
  items: ChatItem[]
  streaming: boolean
  sessionDirectory?: string
  onRetry?: (messageId: string) => void
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  // agents embed local paths as download links — clicking opens the viewer
  const [fileLink, setFileLink] = useState<string | null>(null)
  /*
     A multi-step turn is several assistant messages; intermediate ones
     stay "unfinished" until the turn ends, so gating the cursor on
     !done alone made it appear under every step. It belongs on the
     latest assistant message only.
  */
  const lastAssistantId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === "assistant") return items[i].id
    }
    return undefined
  }, [items])

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
            // the icon-until-server state of a client send: sending, steering,
            // queued, unknown, or failed — delivered bubbles render plain
            const stamp =
              item.pending === "sending"
                ? "Sending…"
                : item.pending === "steering"
                  ? "Steering…"
                  : item.pending === "queued"
                    ? "Queued…"
                    : item.pending === "unknown"
                      ? "Delivery unknown…"
                      : item.pending === "failed"
                        ? "Failed"
                        : undefined
            return (
              <div key={item.id} className={stamp ? "row user pending" : "row user"}>
                <div className="bubble-user">
                  {item.text}
                  {stamp && <span className="pending-stamp">{stamp}</span>}
                </div>
                {item.pending === "failed" && onRetry && (
                  <button className="pending-retry" onClick={() => onRetry(item.id)}>
                    Retry
                  </button>
                )}
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
              {item.error && <ErrorCard error={item.error} />}
              {item.blocks.map((block: Block, i: number) => {
                const key = `${item.id}-${i}`
                if (block.type === "text")
                  return (
                    <Markdown
                      key={key}
                      text={block.text}
                      onFile={(p) => setFileLink(p)}
                    />
                  )
                if (block.type === "reasoning")
                  return <ReasoningBlock key={key} text={block.text} />
                if (block.type === "document")
                  return (
                    <DocumentCard
                      key={key}
                      block={block}
                      sessionDirectory={sessionDirectory}
                    />
                  )
                return (
                  <ToolBlock
                    key={key}
                    block={block}
                    sessionDirectory={sessionDirectory}
                  />
                )
              })}
              {item.id === lastAssistantId && !item.done && streaming && (
                <span className="cursor" />
              )}
            </div>
          )
        })}
        <div ref={endRef} />
      </div>

      {fileLink && (
        <FileViewer
          path={fileLink}
          sessionDirectory={sessionDirectory}
          onClose={() => setFileLink(null)}
        />
      )}
    </div>
  )
}


/* ---------- header usage chip ---------- */

/*
   What OpenCode's API exposes about usage: per-session tokens and cost.
   Provider quota windows (the 5-hour / weekly subscription limits) are not
   in the API yet — when they land upstream, this chip is where they go.
*/
export function UsageChip({ sessions }: { sessions: SessionInfo[] }) {
  type Tok = { input?: number; output?: number; reasoning?: number }
  const tokensOf = (s: SessionInfo): number => {
    const t = s.tokens as Tok | undefined
    return (t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0)
  }
  const now = Date.now()
  const usedIn = (ms: number): number =>
    sessions
      .filter((s) => (s.time?.updated ?? 0) >= now - ms)
      .reduce((sum, s) => sum + tokensOf(s), 0)
  const fiveH = usedIn(5 * 3600_000)
  const week = usedIn(7 * 86400_000)
  if (fiveH === 0 && week === 0) return null
  const fmt = (t: number): string =>
    t >= 1e9
      ? (t / 1e9).toFixed(1) + "B"
      : t >= 1e6
        ? (t / 1e6).toFixed(1) + "M"
        : t >= 1e3
          ? (t / 1e3).toFixed(1) + "k"
          : String(t)
  return (
    <span
      className="usage-chip"
      title="Tokens used in the last 5 hours and 7 days, across this machine's sessions. Provider subscription windows (5h / weekly limits) are not exposed by OpenCode's API yet."
    >
      5h {fmt(fiveH)} · 7d {fmt(week)}
    </span>
  )
}
/* ---------- permission prompt: the script + the decision ---------- */

export function PermissionCard({
  request,
  onReply,
}: {
  request: { action: string; resources: string[]; message?: string }
  onReply: (decision: "once" | "always" | "reject") => void
}) {
  return (
    <div className="perm-card">
      <div className="perm-head">
        OpenCode wants to <strong>{request.action}</strong>
      </div>
      {request.resources.map((r, i) => (
        <pre key={i} className="perm-script">
          {r}
        </pre>
      ))}
      {request.message && <p className="perm-msg">{request.message}</p>}
      <div className="perm-actions">
        <button className="btn-primary" onClick={() => onReply("once")}>
          Allow once
        </button>
        <button className="btn-ghost" onClick={() => onReply("always")}>
          Always
        </button>
        <button className="btn-ghost perm-reject" onClick={() => onReply("reject")}>
          Reject
        </button>
      </div>
    </div>
  )
}

/* ---------- errors: inference / provider / model failures ---------- */

/** The failure attached to a finished assistant message. */
export function ErrorCard({ error }: { error: ErrorInfo }) {
  return (
    <div className={`assistant-error ${error.kind === "interrupted" ? "is-interrupted" : "is-error"}`}>
      <div className="assistant-error-title">{error.title}</div>
      {error.detail && <div className="assistant-error-detail">{error.detail}</div>}
    </div>
  )
}

/**
 * Live banner for the open session: a provider/model failure or an active
 * retry (rate limit with backoff). Cleared by the next attempt.
 */
export function SessionNotice({ notice }: { notice: SessionNotice }) {
  // tick while mounted so the "next in Ns" countdown stays honest
  const [, setTick] = useState(0)
  useEffect(() => {
    if (notice.kind !== "retry" || !notice.next) return
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [notice.kind, notice.next])
  if (notice.kind === "retry") {
    const wait =
      notice.next && notice.next > Date.now()
        ? Math.max(1, Math.round((notice.next - Date.now()) / 1000))
        : null
    return (
      <div className="session-notice is-retry">
        <div className="session-notice-title">
          {notice.title || "Retrying"}
          {typeof notice.attempt === "number" ? ` · attempt ${notice.attempt}` : ""}
          {wait ? ` · next in ${wait}s` : ""}
        </div>
        {notice.detail && <div className="session-notice-detail">{notice.detail}</div>}
      </div>
    )
  }
  return (
    <div className={`session-notice ${notice.kind === "interrupted" ? "is-interrupted" : "is-error"}`}>
      <div className="session-notice-title">{notice.title}</div>
      {notice.detail && <div className="session-notice-detail">{notice.detail}</div>}
    </div>
  )
}

/* ---------- empty state: greeting + composer, no dead-end button ---------- */

const WELCOME_KEY = "agentlink.welcomed"

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

/**
 * First-run onboarding, shown over the app once: what it is, how syncing
 * works (no pairing on the dev path — one OpenCode service, shared
 * sessions), and the two ways to a working model — OpenCode's own free
 * models, or an OAuth sign-in to a subscription. Only "Got it" dismisses
 * it for good; Esc / scrim just close it for this visit.
 */
export function Welcome({
  models,
  pendingModel,
  onModelPick,
  onProviders,
  onApiKey,
  onClose,
}: {
  models: ModelInfo[]
  pendingModel?: ModelRef
  onModelPick: (m: ModelInfo) => void
  onProviders: () => void
  onApiKey: () => void
  onClose: () => void
}) {
  const dismiss = () => {
    localStorage.setItem(WELCOME_KEY, "1")
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const freeCount = models.filter(isFreeModel).length
  return (
    <div className="welcome-overlay" onClick={onClose}>
      <div
        className="welcome-card"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="empty-brand">agentlink</div>
        <h2>A remote for the OpenCode on your machine</h2>
        <p className="empty-sync">
          There's nothing to pair: this app talks to the same OpenCode service
          as your desktop, and sessions are shared live between them. When the
          dot in the header says <span className="conn on">live</span>, you're
          connected.
        </p>
        <ol className="welcome-steps">
        <li>
          <span className="step-num">1</span>
          <div className="step-body">
            <span className="step-title">Pick a model</span>
            <span className="step-detail">
              {freeCount > 0
                ? `OpenCode ships ${freeCount} models that are free — no account, no keys.`
                : "Choose one from the picker."}
            </span>
            <ModelPicker model={pendingModel} models={models} onPick={onModelPick} />
          </div>
        </li>
        <li>
          <span className="step-num">2</span>
          <div className="step-body">
            <span className="step-title">Or use your subscription</span>
            <span className="step-detail">
              Claude (Pro/Max) and ChatGPT (Codex) sign in with OAuth — no API
              keys involved.
            </span>
            <button
              className="btn-ghost"
              onClick={() => {
                dismiss()
                onProviders()
              }}
            >
              Open providers
            </button>
          </div>
        </li>
        <li>
          <span className="step-num">3</span>
          <div className="step-body">
            <span className="step-title">Or bring an API key</span>
            <span className="step-detail">
              Anthropic, OpenAI, Google, DeepSeek and a hundred more — paste a
              key and it lives in OpenCode's own credential store on your
              desktop, never in this app.
            </span>
            <button
              className="btn-ghost"
              onClick={() => {
                dismiss()
                onApiKey()
              }}
            >
              Add an API key
            </button>
          </div>
        </li>
        </ol>
        <p className="empty-hint">Type below to start your first session.</p>
        <div className="welcome-actions">
          <button className="btn-ghost" onClick={dismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------- workspace picker (new sessions) ---------- */

/*
   New sessions default to the folder OpenCode runs in. This lets the user
   aim the session at any directory — recent ones come from their sessions,
   or they type a path.
*/
export function WorkspacePicker({
  value,
  onChange,
  directories,
}: {
  value: string
  onChange: (dir: string) => void
  directories: string[]
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const ref = useOutside(() => setOpen(false))
  return (
    <div className="picker workspace" ref={ref}>
      <button className="picker-btn" onClick={() => setOpen(!open)}>
        <span className="workspace-label">Workspace</span>
        <span className="workspace-value">{value ? fileNameOf(value) : "default"}</span>
        <span className="picker-caret">▾</span>
      </button>
      {open && (
        <div className="picker-menu menu-up">
          {directories.slice(0, 6).map((d) => (
            <button
              key={d}
              className={"picker-item" + (d === value ? " selected" : "")}
              onClick={() => {
                onChange(d)
                setOpen(false)
              }}
            >
              <span className="picker-item-name">{fileNameOf(d)}</span>
              <span className="picker-item-provider">{d}</span>
            </button>
          ))}
          <div className="workspace-custom">
            <input
              className="workspace-input"
              placeholder="or type a folder path…"
              value={draft}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              className="btn-primary"
              disabled={!draft.trim()}
              onClick={() => {
                onChange(draft.trim())
                setDraft("")
                setOpen(false)
              }}
            >
              Use
            </button>
          </div>
          {value && (
            <button
              className="picker-item"
              onClick={() => {
                onChange("")
                setOpen(false)
              }}
            >
              <span className="picker-item-name">default</span>
              <span className="picker-item-provider">the folder OpenCode runs in</span>
            </button>
          )}
        </div>
      )}
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

/* ---------- offline help: opencode not reachable ---------- */

/*
   Shown whenever the service can't be reached (or rejects the password).
   In dev the fix is almost always "start OpenCode / restart the dev
   server"; for the hosted and downloaded variants the fix lives in the
   connect screen instead.
*/
export function OfflineHelp({
  error,
  onRetry,
}: {
  error: "down" | "auth" | null
  onRetry: () => void
}) {
  const auth = error === "auth"
  const hosted = initialConnection != null && !import.meta.env.DEV

  let title: string
  let body: ReactNode
  if (hosted) {
    title = auth ? "Wrong password" : "Can't reach the server"
    body = (
      <p>
        {auth
          ? "The service answered but rejected the password — update it in "
          : "No answer from the server — is OpenCode running? Check the address in "}
        <strong>⋮ → Change connection</strong>.
      </p>
    )
  } else if (auth) {
    title = "OpenCode answered — password changed"
    body = (
      <>
        <p>
          The service rejected the stored credentials. The dev server reads
          the password once at start, so:
        </p>
        <pre>stop the dev server (Ctrl+C), then{"\n"}npm run dev</pre>
      </>
    )
  } else {
    title = "Can't reach OpenCode on this machine"
    body = (
      <>
        <p>
          This app is a remote for an OpenCode running on this same machine.
          To see your work here — and drive it from the phone — install the
          CLI and keep it running on the PC:
        </p>
        <ol>
          <li>
            Install it: <code>npm i -g opencode-ai</code>
          </li>
          <li>
            Start it: run <code>opencode</code> (the TUI) — or{" "}
            <code>opencode serve</code> on a headless box
          </li>
          <li>
            Restart the dev server: <code>npm run dev</code>
          </li>
        </ol>
      </>
    )
  }

  return (
    <div className="offline-help">
      <div className="offline-title">{title}</div>
      {body}
      <p className="offline-why">
        With OpenCode running on the PC, this app shows the same sessions
        live — from the phone or any browser.
      </p>
      <button className="btn-ghost" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}
