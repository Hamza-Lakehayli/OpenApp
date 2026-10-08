import { useEffect, useRef, useState } from "react"
import { client } from "./api"
import type { McpServer, ModelRef } from "@opencode/client"
import {
  BookOpenIcon,
  EyeIcon,
  EyeSlashIcon,
  LinkIcon,
  LinkSlashIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid"

/* ---------- primitives ---------- */

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

function StatusDot({ status }: { status: string }) {
  const cls =
    status === "connected"
      ? "ok"
      : status === "failed"
        ? "bad"
        : status === "needs_auth"
          ? "warn"
          : ""
  return <span className={"tool-dot " + cls} />
}

/* ---------- the ⋮ menu ---------- */

export type Panel = "mcp" | "skills" | "providers" | null

export function SettingsMenu({
  onOpen,
}: {
  onOpen: (panel: Exclude<Panel, null>) => void
}) {
  // Internal open state: deliberately NOT tied to the panel — tying them
  // meant the menu stayed open behind the panel and every click inside the
  // panel hit this menu's outside-handler, closing the panel instantly.
  const [open, setOpen] = useState(false)
  const ref = useOutside(() => setOpen(false))
  return (
    <div className="picker" ref={ref}>
      <button
        className="icon-btn"
        aria-label="Settings"
        onClick={() => setOpen(!open)}
      >
        ⋮
      </button>
      {open && (
        <div className="picker-menu menu-right">
          <button
            className="picker-item"
            onClick={() => {
              setOpen(false)
              onOpen("mcp")
            }}
          >
            <span className="picker-item-name">MCP servers</span>
            <span className="picker-item-provider">
              add, edit, remove, connect, resources
            </span>
          </button>
          <button
            className="picker-item"
            onClick={() => {
              setOpen(false)
              onOpen("skills")
            }}
          >
            <span className="picker-item-name">Skills</span>
            <span className="picker-item-provider">
              view, add, remove SKILL.md files
            </span>
          </button>
          <button
            className="picker-item"
            onClick={() => {
              setOpen(false)
              onOpen("providers")
            }}
          >
            <span className="picker-item-name">Providers</span>
            <span className="picker-item-provider">
              sign in — OAuth works from this phone too
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

/* ---------- MCP panel ---------- */

type McpConfigShape = {
  type?: string
  url?: string
  command?: string[]
  cwd?: string
  environment?: Record<string, string>
  headers?: Record<string, string>
}

/** Parse `KEY=value` lines into a record (shared by env and headers fields). */
function parseKeyValue(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const eq = line.indexOf("=")
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

function McpForm({
  initialName,
  initialConfig,
  onSubmit,
  onClose,
}: {
  initialName?: string
  initialConfig?: McpConfigShape | null
  onSubmit: (name: string, config: Record<string, unknown>) => void
  onClose: () => void
}) {
  const editing = Boolean(initialName)
  const initial: McpConfigShape = initialConfig ?? {}
  const [name, setName] = useState(initialName ?? "")
  const [type, setType] = useState<"local" | "remote">(
    initial.type === "local" ? "local" : "remote",
  )
  const [url, setUrl] = useState(initial.url ?? "")
  const [command, setCommand] = useState((initial.command ?? []).join(" "))
  const [cwd, setCwd] = useState(initial.cwd ?? "")
  const [env, setEnv] = useState(
    Object.entries(initial.environment ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  )
  const [headers, setHeaders] = useState(
    Object.entries(initial.headers ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  )

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const config: Record<string, unknown> = { type }
    if (type === "remote") {
      const parsed = url.trim()
      if (!parsed) return
      config.url = parsed
      // remote servers authenticate with headers, not env — and a token
      // header opts out of the OAuth login dance (needs_auth otherwise).
      const headerLines = parseKeyValue(headers)
      if (Object.keys(headerLines).length) {
        config.headers = headerLines
        config.oauth = false
      }
    } else {
      const argv = command.trim().split(/\s+/)
      if (!argv.length) return
      config.command = argv
      if (cwd.trim()) config.cwd = cwd.trim()
      const envLines = parseKeyValue(env)
      if (Object.keys(envLines).length) config.environment = envLines
    }
    onSubmit(trimmed, config)
    onClose()
  }

  return (
    <div className="panel-form">
      <input
        className="field"
        placeholder="name (e.g. github)"
        value={name}
        disabled={editing}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="seg">
        <button
          className={"seg-btn" + (type === "remote" ? " sel" : "")}
          onClick={() => setType("remote")}
        >
          Remote (URL)
        </button>
        <button
          className={"seg-btn" + (type === "local" ? " sel" : "")}
          onClick={() => setType("local")}
        >
          Local (command)
        </button>
      </div>
      {type === "remote" ? (
        <>
          <input
            className="field"
            placeholder="https://example.com/mcp"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <textarea
            className="field"
            rows={2}
            placeholder={"headers, KEY=value per line — e.g. Authorization=Bearer <token>"}
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
          />
          {initial.environment && Object.keys(initial.environment).length > 0 && (
            <div className="field-hint">
              This server's stored config has environment variables — remote
              servers ignore them. Put the token in headers instead
              (Authorization=Bearer …).
            </div>
          )}
          <div className="field-hint">
            Remote servers authenticate with headers — GitHub: a Bearer token.
            Environment variables only apply to local (command) servers.
          </div>
        </>
      ) : (
        <>
          <input
            className="field"
            placeholder="command + args (e.g. npx -y @modelcontextprotocol/server-github)"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <input
            className="field"
            placeholder="working directory (optional)"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
          />
          <textarea
            className="field"
            rows={2}
            placeholder={"environment variables, KEY=value per line (optional)"}
            value={env}
            onChange={(e) => setEnv(e.target.value)}
          />
        </>
      )}
      <div className="form-actions">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" onClick={submit}>
          {editing ? "Save changes" : "Add server"}
        </button>
      </div>
    </div>
  )
}

export function McpPanel({
  sessionDirectory,
  onClose,
}: {
  sessionDirectory?: string
  onClose: () => void
}) {
  const [servers, setServers] = useState<McpServer[]>([])
  const [configs, setConfigs] = useState<Record<string, McpConfigShape>>({})
  const [resources, setResources] = useState<Record<string, { name: string; uri: string }[]>>({})
  const [showResources, setShowResources] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const location = sessionDirectory
    ? { location: { directory: sessionDirectory } }
    : {}

  const load = async () => {
    try {
      const res = await client.mcp.list(location)
      setServers(res.data)
      // pre-fill source for Edit: the config layers carry mcp.servers
      try {
        const cfg = await client.config.get()
        const layers = (
          Array.isArray(cfg) ? cfg : ((cfg as { data?: unknown }).data ?? [])
        ) as Array<{ info?: { mcp?: { servers?: Record<string, McpConfigShape> } } }>
        const merged: Record<string, McpConfigShape> = {}
        for (const layer of layers) {
          const servers = layer?.info?.mcp?.servers
          if (servers && typeof servers === "object") Object.assign(merged, servers)
        }
        setConfigs(merged)
      } catch {
        /* pre-fill is best-effort */
      }
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }

  useEffect(() => {
    load()
  }, [sessionDirectory])

  const upsert = async (name: string, config: Record<string, unknown>) => {
    setBusy(name)
    try {
      await client.mcp.add({ server: name, config, ...location } as never)
      // mcp.add is in-memory only: also write the user's opencode.json (the
      // document config layer) so the server survives service restarts.
      await persistServers((servers) => ({ ...servers, [name]: config }))
      await load()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (name: string) => {
    setBusy(name)
    try {
      await client.mcp.remove({ server: name, ...location })
      await persistServers((servers) => {
        const next = { ...servers }
        delete next[name]
        return next
      })
      await load()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Persist mcp.servers into the user's opencode.json. `mcp.add`/`remove`
   * only touch the running service's memory, so a restart loses them; the
   * config file is what survives. The config layers carry the *complete*
   * parsed document (verified identical to the file), so a read-modify-write
   * through the fs API cannot clobber other keys.
   */
  const persistServers = async (
    update: (servers: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    try {
      const cfg = await client.config.get()
      const layers = (
        Array.isArray(cfg) ? cfg : ((cfg as { data?: unknown }).data ?? [])
      ) as Array<{
        type?: string
        path?: string
        info?: Record<string, unknown>
      }>
      const doc = layers.find((l) => l.type === "document" && l.path && l.info)
      if (!doc?.path || !doc.info) return
      const disk = JSON.parse(JSON.stringify(doc.info)) as {
        mcp?: { servers?: Record<string, unknown> }
      }
      const mcp = disk.mcp ?? {}
      mcp.servers = update(mcp.servers ?? {})
      disk.mcp = mcp
      const bytes = new TextEncoder().encode(JSON.stringify(disk, null, 2))
      await client.file.write({ path: doc.path, payload: bytes })
    } catch (err) {
      // persistence is best-effort: the in-memory add already worked
      console.error("config persistence failed", err)
    }
  }

  const toggleConnection = async (server: McpServer) => {
    const connected = server.status.status === "connected"
    setBusy(server.name)
    try {
      if (connected) {
        await client.mcp.disconnect({ server: server.name, ...location })
      } else {
        await client.mcp.connect({ server: server.name, ...location })
      }
      await load()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const loadResources = async () => {
    if (showResources) {
      setShowResources(false)
      return
    }
    try {
      const res = await client.mcp.resource.catalog(location)
      const byServer: Record<string, { name: string; uri: string }[]> = {}
      for (const r of res.data.resources) {
        byServer[r.server] = [...(byServer[r.server] ?? []), { name: r.name, uri: r.uri }]
      }
      setResources(byServer)
      setShowResources(true)
    } catch (err) {
      setError(String(err))
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>MCP servers</h3>
        <div className="panel-actions">
          <button
            className="btn-icon"
            title={showResources ? "Hide resources" : "Resources"}
            aria-label={showResources ? "Hide resources" : "Resources"}
            onClick={loadResources}
          >
            {showResources ? <EyeSlashIcon /> : <BookOpenIcon />}
          </button>
          <button
            className="btn-icon"
            title={adding ? "Close form" : "Add server"}
            aria-label={adding ? "Close form" : "Add server"}
            onClick={() => {
              setAdding(!adding)
              setEditing(null)
            }}
          >
            <PlusIcon />
          </button>
          <button className="icon-btn" title="Close" aria-label="Close panel" onClick={onClose}>
            <XMarkIcon />
          </button>
        </div>
      </div>

      {error && <div className="panel-error">{error}</div>}

      {adding && (
        <McpForm onSubmit={upsert} onClose={() => setAdding(false)} />
      )}
      {editing && (
        <McpForm
          initialName={editing}
          initialConfig={configs[editing] ?? null}
          onSubmit={upsert}
          onClose={() => setEditing(null)}
        />
      )}

      <div className="panel-list">
        {servers.map((s) => (
          <div key={s.name} className="panel-row">
            <StatusDot status={s.status.status} />
            <div className="panel-row-main">
              <span className="panel-row-name">{s.name}</span>
              <span className="panel-row-sub">
                {s.status.status === "failed" || s.status.status === "needs_auth"
                  ? (s.status as { error?: string }).error || s.status.status
                  : s.status.status}
              </span>
            </div>
            <div className="panel-row-actions">
              <button
                className="btn-icon"
                title="Edit"
                aria-label="Edit server"
                disabled={busy === s.name}
                onClick={() => {
                  setEditing(s.name)
                  setAdding(false)
                }}
              >
                <PencilSquareIcon />
              </button>
              {s.status.status !== "pending" && (
                <button
                  className="btn-icon"
                  title={s.status.status === "connected" ? "Disconnect" : "Connect"}
                  aria-label={s.status.status === "connected" ? "Disconnect server" : "Connect server"}
                  disabled={busy === s.name}
                  onClick={() => toggleConnection(s)}
                >
                  {s.status.status === "connected" ? <LinkSlashIcon /> : <LinkIcon />}
                </button>
              )}
              <button
                className="btn-icon danger"
                title="Remove"
                aria-label="Remove server"
                disabled={busy === s.name}
                onClick={() => remove(s.name)}
              >
                <TrashIcon />
              </button>
            </div>
            {showResources && resources[s.name] && (
              <div className="panel-resources">
                {resources[s.name].map((r) => (
                  <div key={r.uri} className="panel-resource">
                    <span className="panel-row-name">{r.name}</span>
                    <span className="panel-row-sub">{r.uri}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {servers.length === 0 && (
          <div className="panel-empty">No MCP servers configured</div>
        )}
      </div>
    </div>
  )
}

/* ---------- Providers panel ---------- */

type IntegrationMethod = {
  id?: string
  type?: string
  label?: string
  form?: Array<{
    key: string
    title?: string
    type?: string
    placeholder?: string
    options?: Array<{ value: string; label?: string; description?: string }>
    when?: Array<{ key: string; op: string; value: string }>
  }>
}

type IntegrationInfo = {
  id: string
  name: string
  methods?: IntegrationMethod[]
  connections?: Array<Record<string, unknown>>
}

type AttemptState = {
  integrationID: string
  methodLabel: string
  data: {
    attemptID: string
    url: string
    instructions: string
    mode: "auto" | "code"
    time: { created: number; expires: number }
  }
}

/*
   Providers panel: the OAuth sign-ins, driven entirely through the server's
   integration API — begin an attempt, hand the user the URL (and the code
   for device flows), poll until the server sees the flow land. Device-code
   methods complete from any browser, including this phone; loopback-callback
   methods need the desktop's browser.
*/
export function ProvidersPanel({ onClose }: { onClose: () => void }) {
  const [integrations, setIntegrations] = useState<IntegrationInfo[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [attempt, setAttempt] = useState<AttemptState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = async () => {
    try {
      const res = await client.integration.list()
      const list = (
        Array.isArray(res) ? res : ((res as { data?: unknown }).data ?? [])
      ) as IntegrationInfo[]
      setIntegrations(
        list.filter((i) => (i.methods ?? []).some((m) => m.type === "oauth")),
      )
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }

  useEffect(() => {
    load()
  }, [])

  // the active attempt: the server completes it once the browser flow lands
  useEffect(() => {
    if (!attempt) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await client.integration.oauth.status({
          integrationID: attempt.integrationID,
          attemptID: attempt.data.attemptID,
        })
        const status = (res as { data?: { status?: string } }).data?.status
        if (status === "complete") {
          if (!stopped) {
            setAttempt(null)
            setAnswers({})
            await load()
          }
          return
        }
      } catch {
        /* expired or gone: keep polling until cancelled */
      }
      if (!stopped) timer = setTimeout(tick, 2000)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [attempt])

  const beginOAuth = async (integration: IntegrationInfo, method: IntegrationMethod) => {
    setBusy(integration.id)
    try {
      const formAnswers: Record<string, string> = {}
      for (const field of method.form ?? []) {
        if (answers[field.key]) formAnswers[field.key] = answers[field.key]
      }
      const res = await client.integration.oauth.connect({
        integrationID: integration.id,
        methodID: method.id ?? integration.id,
        ...(Object.keys(formAnswers).length ? { answer: formAnswers } : {}),
      } as never)
      const data = (res as { data?: AttemptState["data"] }).data
      if (!data?.attemptID) throw new Error("no attempt returned")
      setAttempt({
        integrationID: integration.id,
        methodLabel: method.label ?? integration.name,
        data,
      })
      setExpanded(null)
      setError(null)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const cancelAttempt = async () => {
    const a = attempt
    setAttempt(null)
    setAnswers({})
    if (!a) return
    try {
      await client.integration.oauth.cancel({
        integrationID: a.integrationID,
        attemptID: a.data.attemptID,
      } as never)
    } catch {
      /* best-effort */
    }
  }

  const codeIn = (instructions: string): string | undefined =>
    instructions.match(/code[:\s]+([A-Za-z0-9][A-Za-z0-9-]{3,})/i)?.[1]

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  const whenMatches = (field: NonNullable<IntegrationMethod["form"]>[number]) => {
    for (const w of field.when ?? []) {
      if (w.op === "eq" && answers[w.key] !== w.value) return false
    }
    return true
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Providers</h3>
        <div className="panel-actions">
          <button className="icon-btn" title="Close" aria-label="Close panel" onClick={onClose}>
            <XMarkIcon />
          </button>
        </div>
      </div>

      {error && <div className="panel-error">{error}</div>}

      {attempt && (
        <div className="panel-form">
          <div className="auth-title">Sign in — {attempt.methodLabel}</div>
          <div className="auth-instructions">{attempt.data.instructions}</div>
          {codeIn(attempt.data.instructions) && (
            <button
              className="auth-code"
              title="Tap to copy"
              onClick={() => copyCode(codeIn(attempt.data.instructions) as string)}
            >
              {copied ? "copied ✓" : codeIn(attempt.data.instructions)}
            </button>
          )}
          <a className="auth-link" href={attempt.data.url} target="_blank" rel="noreferrer">
            Open the login page <span aria-hidden="true">↗</span>
          </a>
          <div className="auth-wait">
            <span className="tool-dot run" /> waiting for you to finish in the
            browser…
          </div>
          <div className="form-actions">
            <button className="btn-ghost" onClick={cancelAttempt}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="panel-list">
        {integrations.map((i) => {
          const methods = (i.methods ?? []).filter((m) => m.type === "oauth")
          const connected = (i.connections ?? []).length > 0
          return (
            <div key={i.id} className="panel-row">
              <StatusDot status={connected ? "connected" : ""} />
              <div className="panel-row-main">
                <span className="panel-row-name">{i.name}</span>
                <span className="panel-row-sub">
                  {connected
                    ? "connected"
                    : methods.map((m) => m.label ?? m.id).join(" · ")}
                </span>
              </div>
              <div className="panel-row-actions">
                {methods.length === 1 ? (
                  <button
                    className="btn-ghost"
                    disabled={busy === i.id}
                    onClick={() => beginOAuth(i, methods[0])}
                  >
                    Sign in
                  </button>
                ) : (
                  <button
                    className="btn-ghost"
                    disabled={busy === i.id}
                    onClick={() => setExpanded(expanded === i.id ? null : i.id)}
                  >
                    {expanded === i.id ? "Close" : "Sign in"}
                  </button>
                )}
              </div>
              {expanded === i.id && (
                <div className="panel-resources">
                  {methods.map((m) => (
                    <div key={m.id ?? m.label} className="panel-resource">
                      {(m.form ?? [])
                        .filter(whenMatches)
                        .map((f) =>
                          f.options ? (
                            <select
                              key={f.key}
                              className="field"
                              value={answers[f.key] ?? ""}
                              onChange={(e) =>
                                setAnswers({ ...answers, [f.key]: e.target.value })
                              }
                            >
                              <option value="">{f.title ?? f.key}</option>
                              {f.options.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label ?? o.value}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              key={f.key}
                              className="field"
                              placeholder={f.placeholder ?? f.title ?? f.key}
                              value={answers[f.key] ?? ""}
                              onChange={(e) =>
                                setAnswers({ ...answers, [f.key]: e.target.value })
                              }
                            />
                          ),
                        )}
                      <button
                        className="btn-ghost"
                        disabled={busy === i.id}
                        onClick={() => beginOAuth(i, m)}
                      >
                        {m.label ?? m.id}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {integrations.length === 0 && (
          <div className="panel-empty">No OAuth providers found</div>
        )}
      </div>
    </div>
  )
}

/* ---------- Skills panel ---------- */

type SkillEntry = {
  id: string
  name: string
  description?: string
  path: string
  content: string
}

function SkillAddForm({
  onAdd,
  onClose,
}: {
  onAdd: (name: string, description: string, instructions: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [instructions, setInstructions] = useState("")

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed || !description.trim()) return
    onAdd(trimmed, description.trim(), instructions)
    onClose()
  }

  return (
    <div className="panel-form">
      <input
        className="field"
        placeholder="skill id (e.g. triage-ci)"
        value={name}
        onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase())}
      />
      <input
        className="field"
        placeholder="when to use it (description — the agent reads this)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <textarea
        className="field"
        rows={5}
        placeholder="instructions (the SKILL.md body)"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
      />
      <div className="form-actions">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" onClick={submit}>
          Create skill
        </button>
      </div>
    </div>
  )
}

export function SkillsPanel({
  sessionDirectory,
  onClose,
}: {
  sessionDirectory?: string
  onClose: () => void
}) {
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const location = sessionDirectory
    ? { location: { directory: sessionDirectory } }
    : undefined

  const load = async () => {
    try {
      const res = await client.skill.list(location)
      setSkills(res.data as SkillEntry[])
      setError(null)
    } catch (err) {
      setError(String(err))
    }
  }

  useEffect(() => {
    load()
  }, [sessionDirectory])

  const skillDirFor = (path?: string): string => {
    if (sessionDirectory) return sessionDirectory
    if (path) {
      // derive the project root from an existing skill path: <root>/.opencode/skills/...
      const marker = path.replace(/\\/g, "/").indexOf("/.opencode/skills/")
      if (marker > 0) return path.slice(0, marker)
    }
    return ""
  }

  const add = async (name: string, description: string, instructions: string) => {
    setBusy(name)
    try {
      const dir = skillDirFor(skills[0]?.path) || sessionDirectory || ""
      const target = `${dir.replace(/\\/g, "/").replace(/\/$/, "")}/.opencode/skills/${name}/SKILL.md`
      const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions || description}\n`
      const bytes = new TextEncoder().encode(content)
      await client.file.write({ location: { directory: dir }, path: target, payload: bytes })
      await load()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (skill: SkillEntry) => {
    setBusy(skill.name)
    try {
      // no fs/delete in the API: run the removal through the shell API
      const dir = skillDirFor(skill.path)
      const winPath = skill.path.replace(/\//g, "\\")
      const command = `Remove-Item -Recurse -Force '${winPath}'`
      await client.shell.create(
        { command, ...(dir ? { location: { directory: dir } } : {}) } as never,
      )
      await load()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Skills</h3>
        <div className="panel-actions">
          <button
            className="btn-icon"
            title={adding ? "Close form" : "Add skill"}
            aria-label={adding ? "Close form" : "Add skill"}
            onClick={() => setAdding(!adding)}
          >
            <PlusIcon />
          </button>
          <button className="icon-btn" title="Close" aria-label="Close panel" onClick={onClose}>
            <XMarkIcon />
          </button>
        </div>
      </div>

      {error && <div className="panel-error">{error}</div>}
      {sessionDirectory === undefined && (
        <div className="panel-note">
          Open a session to scope skills to its project.
        </div>
      )}

      {adding && (
        <SkillAddForm onAdd={add} onClose={() => setAdding(false)} />
      )}

      <div className="panel-list">
        {skills.map((s) => {
          const isBuiltin = s.path.startsWith("/builtin")
          return (
            <div key={s.id} className="panel-row">
              <div className="panel-row-main">
                <span className="panel-row-name">{s.name}</span>
                <span className="panel-row-sub">
                  {s.description || (isBuiltin ? "built-in" : s.path)}
                </span>
              </div>
              <div className="panel-row-actions">
                {!isBuiltin && (
                  <>
                    <button
                      className="btn-icon"
                      title={expanded === s.id ? "Hide" : "View"}
                      aria-label={expanded === s.id ? "Hide skill" : "View skill"}
                      onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                    >
                      {expanded === s.id ? <EyeSlashIcon /> : <EyeIcon />}
                    </button>
                    <button
                      className="btn-icon danger"
                      title="Remove"
                      aria-label="Remove skill"
                      disabled={busy === s.name}
                      onClick={() => remove(s)}
                    >
                      <TrashIcon />
                    </button>
                  </>
                )}
              </div>
              {expanded === s.id && (
                <div className="panel-resource">
                  <pre className="tool-io">{s.content}</pre>
                </div>
              )}
            </div>
          )
        })}
        {skills.length === 0 && (
          <div className="panel-empty">No skills discovered</div>
        )}
      </div>
    </div>
  )
}

/* ---------- the panel host ---------- */

export function SettingsPanel({
  panel,
  sessionDirectory,
  onClose,
}: {
  panel: Panel
  sessionDirectory?: string
  onClose: () => void
}) {
  if (!panel) return null
  return (
    <>
      <div className="scrim-high" onClick={onClose} />
      <div className="panel-host">
        {panel === "mcp" ? (
          <McpPanel sessionDirectory={sessionDirectory} onClose={onClose} />
        ) : panel === "providers" ? (
          <ProvidersPanel onClose={onClose} />
        ) : (
          <SkillsPanel sessionDirectory={sessionDirectory} onClose={onClose} />
        )}
      </div>
    </>
  )
}

export type { ModelRef }
