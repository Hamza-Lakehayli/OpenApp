import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { client } from "./api"
import type {
  AgentInfo,
  ModelInfo,
  ModelRef,
  SessionInfo,
  SessionMessageInfo,
  V2Event,
} from "@opencode/client"
import { ChatView, ConfirmDialog, EmptyState, OfflineHelp, Sidebar, UsageChip, Welcome, WorkspacePicker } from "./components"
import type { ConfirmRequest } from "./components"
import type { AgentOption, ChatItem } from "./types"
import { Composer } from "./composer"
import { SettingsMenu, SettingsPanel, type Panel } from "./settings"
import { ConnectScreen, PairSheet } from "./connect"
import { initialConnection } from "./connection"
import { toChatItems, timeAgo } from "./types"
import { touchRecent } from "./recent"

const DEFAULT_DIRECTORY = ""

type Running = Record<string, boolean> // sessionID -> busy

export function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [items, setItems] = useState<ChatItem[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [running, setRunning] = useState<Running>({})
  const [connected, setConnected] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  // the delete button asks first; archive is the default parting, erase the opt-in
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  // choices made before a session exists (the greeting screen): applied on create
  const [pendingModel, setPendingModel] = useState<ModelInfo | undefined>(undefined)
  const [pendingAgent, setPendingAgent] = useState<string | undefined>(undefined)
  // the shipping gate: no connection config (outside dev) → the connect screen
  const [configured] = useState(initialConnection != null || import.meta.env.DEV)
  const [welcome, setWelcome] = useState(
    () => localStorage.getItem("agentlink.welcomed") !== "1",
  )
  const [pair, setPair] = useState(false)
  const [changeConn, setChangeConn] = useState(false)
  const [providerView, setProviderView] = useState<"oauth" | "key">("oauth")
  // workspace for the next new session (greeting-screen picker)
  const [workspace, setWorkspace] = useState("")
  // service reachability: down (not running) vs auth (stale password)
  const [connError, setConnError] = useState<"down" | "auth" | null>(null)

  const activeSession = sessions.find((s) => s.id === activeId)
  const workspaceDirs = useMemo(
    () =>
      [
        ...new Set(
          sessions
            .map((s) => s.location?.directory)
            .filter((d): d is string => Boolean(d)),
        ),
      ].slice(0, 12),
    [sessions],
  )
  const activeRef = useRef<string | undefined>(undefined)
  activeRef.current = activeId

  /* ---------- data loading ---------- */

  const loadSessions = useCallback(async () => {
    try {
      const res = await client.session.list()
      setSessions(res.data)
      setConnected(true)
      return res.data
    } catch {
      setConnected(false)
      return []
    }
  }, [])

  // classify a dead connection: server down vs password rejected
  const probe = useCallback(async (): Promise<boolean> => {
    try {
      await client.server.info()
      setConnError(null)
      return true
    } catch (err) {
      const e = err as { status?: number; message?: string }
      const auth = e?.status === 401 || /401|unauthor/i.test(e?.message ?? "")
      setConnError(auth ? "auth" : "down")
      return false
    }
  }, [])

  const refreshConnection = useCallback(async () => {
    const ok = await probe()
    if (ok) await loadSessions()
    return ok
  }, [probe, loadSessions])

  // while offline, keep checking — the user may start OpenCode any moment
  useEffect(() => {
    if (connected) return
    void refreshConnection()
    const t = setInterval(() => void refreshConnection(), 15000)
    return () => clearInterval(t)
  }, [connected, refreshConnection])

  const loadMessages = useCallback(async (sessionID: string) => {
    try {
      const res = await client.message.list({ sessionID, order: "desc", limit: 200 })
      setItems(toChatItems([...res.data].reverse()))
    } catch {
      setItems([])
    }
  }, [])

  const loadMeta = useCallback(async () => {
    try {
      const [m, a, active] = await Promise.all([
        client.model.list(),
        client.agent.list(),
        client.session.active(),
      ])
      const usable = m.data.filter((x) => x.enabled && x.status !== "deprecated")
      setModels(usable)
      setAgents(
        a.data
          .filter((x: AgentInfo) => x.mode !== "subagent" && !x.hidden)
          .map((x) => ({ id: x.id, name: x.name, description: x.description })),
      )
      const busy: Running = {}
      for (const id of Object.keys(active)) {
        busy[id] = true
      }
      setRunning(busy)
    } catch {
      /* the server will retry on next event */
    }
  }, [])

  /* ---------- event pump: the live sync ---------- */

  useEffect(() => {
    let cancelled = false
    let iterator: AsyncIterator<V2Event> | undefined

    const refreshSessions = debounce(async () => {
      await loadSessions()
    }, 300)

    const refreshActive = debounce(async () => {
      const id = activeRef.current
      if (id) await loadMessages(id)
    }, 250)

    const start = async () => {
      try {
        for await (const event of client.event.subscribe()) {
          if (cancelled) return
          handleEvent(event)
        }
      } catch {
        // live-only, no auto-reconnect: back off and resubscribe
        if (!cancelled) setTimeout(start, 2000)
      }
    }

    const handleEvent = (event: V2Event) => {
      const type = event.type as string
      const data = (event as { data?: Record<string, unknown> }).data ?? {}
      const sessionID = data.sessionID as string | undefined
      const active = activeRef.current

      if (type.startsWith("session.created") || type.startsWith("session.deleted")) {
        refreshSessions()
        return
      }

      if (type === "session.execution.started" && sessionID) {
        setRunning((r) => ({ ...r, [sessionID]: true }))
        refreshSessions()
        return
      }
      if (
        (type === "session.execution.succeeded" ||
          type === "session.execution.failed" ||
          type === "session.execution.interrupted") &&
        sessionID
      ) {
        setRunning((r) => ({ ...r, [sessionID]: false }))
        refreshSessions()
        if (sessionID === active) refreshActive()
        return
      }

      // anything content-shaped in the open session: re-render it live
      if (sessionID && sessionID === active) {
        if (
          type.startsWith("session.text.") ||
          type.startsWith("session.reasoning.") ||
          type.startsWith("session.tool.") ||
          type.startsWith("session.step.") ||
          type === "session.usage.updated" ||
          type === "session.inbox.delivered"
        ) {
          refreshActive()
        }
      }
    }

    start()
    return () => {
      cancelled = true
    }
  }, [loadSessions, loadMessages])

  /* ---------- boot ---------- */

  useEffect(() => {
    loadSessions().then((list) => {
      // archived sessions stay on the server but don't reopen on boot
      const active = list.filter(
        (s) => !(s.metadata as { archived?: number } | undefined)?.archived,
      )
      if (active.length > 0) {
        const mostRecent = [...active].sort(
          (a, b) => b.time.updated - a.time.updated,
        )[0]
        setActiveId(mostRecent.id)
      }
    })
    loadMeta()
  }, [loadSessions, loadMeta])

  useEffect(() => {
    if (activeId) {
      setItems([])
      loadMessages(activeId)
    } else {
      setItems([])
    }
  }, [activeId, loadMessages])

  // using a session marks its model recently used, even without an explicit pick
  useEffect(() => {
    touchRecent(activeSession?.model)
  }, [activeSession?.model])

  /* ---------- actions ---------- */

  const createSession = async (): Promise<string | undefined> => {
    try {
      const session = await client.session.create({
        ...(workspace ? { location: { directory: workspace } } : {}),
        ...(pendingModel
          ? {
              model: {
                id: pendingModel.id,
                providerID: pendingModel.providerID,
                variant: pendingModel.variants[0]?.id,
              },
            }
          : {}),
        ...(pendingAgent ? { agent: pendingAgent } : {}),
      })
      await loadSessions()
      setActiveId(session.id)
      setPendingModel(undefined)
      setPendingAgent(undefined)
      setSidebarOpen(false)
      return session.id
    } catch (err) {
      console.error(err)
      return undefined
    }
  }

  const send = async (text: string) => {
    let id = activeId
    if (!id) {
      // the greeting screen: the session is created by the first message
      id = await createSession()
      if (!id) return
    } else {
      // optimistic bubble only for an existing chat; a fresh one loads from the server
      setItems((prev) => [
        ...prev,
        { kind: "user", id: `temp-${Date.now()}`, text, time: Date.now() },
      ])
    }
    setRunning((r) => ({ ...r, [id]: true }))
    try {
      await client.session.prompt({ sessionID: id, text, delivery: "steer" })
    } catch (err) {
      console.error(err)
    }
    if (activeId === id) await loadMessages(id)
  }

  const stop = async () => {
    if (!activeId) return
    try {
      await client.session.interrupt({ sessionID: activeId })
    } catch (err) {
      console.error(err)
    }
  }

  /*
     Archive is the parting move: nothing is erased — the session's metadata
     gains `archived: <timestamp>` and the sidebar tucks it under Archived.
     PATCH replaces the whole metadata object, so read-merge-write via
     session.get first (verified against the live API).
  */
  const archiveSession = async (id: string) => {
    try {
      const res = await client.session.get({ sessionID: id })
      const metadata = { ...(res.metadata ?? {}), archived: Date.now() }
      await client.session.update({ sessionID: id, metadata })
      if (id === activeId) setActiveId(undefined)
      await loadSessions()
    } catch (err) {
      console.error(err)
    }
  }

  const restoreSession = async (id: string) => {
    try {
      const res = await client.session.get({ sessionID: id })
      const metadata = { ...(res.metadata ?? {}) }
      delete (metadata as { archived?: number }).archived
      await client.session.update({ sessionID: id, metadata })
      await loadSessions()
      setActiveId(id)
      setSidebarOpen(true)
    } catch (err) {
      console.error(err)
    }
  }

  const removeSession = async (id: string) => {
    try {
      await client.session.remove({ sessionID: id })
      if (id === activeId) setActiveId(undefined)
      await loadSessions()
    } catch (err) {
      console.error(err)
    }
  }

  /* the ✕ on a session: confirm, then archive */
  const requestArchive = (id: string) => {
    const s = sessions.find((x) => x.id === id)
    setConfirm({
      title: "Archive session?",
      message: `"${s?.title || "Untitled"}" moves to the Archived list — nothing is deleted and you can restore it anytime.`,
      confirmLabel: "Archive",
      action: () => void archiveSession(id),
    })
  }

  /* the ✕ inside the Archived list: confirm harder, then erase */
  const requestDeleteForever = (id: string) => {
    const s = sessions.find((x) => x.id === id)
    setConfirm({
      title: "Delete forever?",
      message: `"${s?.title || "Untitled"}" and all its messages are removed for good. This cannot be undone.`,
      confirmLabel: "Delete forever",
      danger: true,
      action: () => void removeSession(id),
    })
  }

  const pickModel = async (m: ModelInfo) => {
    touchRecent(m) // the picker's "Recently used" group
    if (!activeId) {
      // greeting screen: remember the choice for the session we will create
      setPendingModel(m)
      return
    }
    try {
      await client.session.switchModel({
        sessionID: activeId,
        model: { id: m.id, providerID: m.providerID, variant: m.variants[0]?.id },
      })
      await loadSessions()
    } catch (err) {
      console.error(err)
    }
  }

  const pickAgent = async (a: AgentOption) => {
    if (!activeId) {
      setPendingAgent(a.id)
      return
    }
    try {
      await client.session.switchAgent({ sessionID: activeId, agent: a.id })
      await loadSessions()
    } catch (err) {
      console.error(err)
    }
  }

  /* ---------- render ---------- */

  const busy = activeId ? Boolean(running[activeId]) : false

  // no connection yet: first run of the deployed app (or a bad stored one)
  if (!configured) return <ConnectScreen />

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id)
          setSidebarOpen(false)
        }}
        onCreate={() => {
          // "New session" returns to the greeting screen; the session is
          // created by the first message, so no empty sessions pile up.
          setActiveId(undefined)
          setSidebarOpen(false)
        }}
        onArchive={requestArchive}
        onRestore={restoreSession}
        onDeleteForever={requestDeleteForever}
        open={sidebarOpen}
        onOpen={() => setSidebarOpen(true)}
        onClose={() => setSidebarOpen(false)}
      />

      <main className="main">
        <header className="header">
          <button
            className="menu-btn"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Menu"
          >
            ☰
          </button>
          <div className="header-title">
            {activeSession?.title || "New session"}
          </div>
          <div className="header-meta">
            {busy && <span className="running-dot" title="Working" />}
            {activeSession && (
              <UsageChip sessions={sessions} />
            )}
            <span className={"conn " + (connected ? "on" : "off")}>
              {connected ? "live" : "offline"}
            </span>
            {activeId && (
              <SettingsMenu
                onOpen={(p) => {
                  if (p === "providers") setProviderView("oauth")
                  setPanel(p)
                }}
                onPair={() => setPair(true)}
                onConnection={() => setChangeConn(true)}
              />
            )}
          </div>
        </header>

        {!connected && (
          <OfflineHelp
            error={connError}
            onRetry={() => void refreshConnection()}
          />
        )}

        {activeId ? (
          <>
            <ChatView
              items={items}
              streaming={busy}
              sessionDirectory={activeSession?.location?.directory}
            />
            <Composer
              disabled={!connected}
              running={busy}
              onSend={send}
              onStop={stop}
              model={activeSession?.model as ModelRef | undefined}
              models={models}
              onModelPick={pickModel}
              agent={activeSession?.agent}
              agents={agents}
              onAgentPick={pickAgent}
            />
          </>
        ) : (
          <EmptyState>
            <WorkspacePicker
              value={workspace}
              onChange={setWorkspace}
              directories={workspaceDirs}
            />
            <Composer
              disabled={!connected}
              running={false}
              onSend={send}
              onStop={stop}
              model={
                pendingModel
                  ? { id: pendingModel.id, providerID: pendingModel.providerID, variant: pendingModel.variants[0]?.id }
                  : undefined
              }
              models={models}
              onModelPick={pickModel}
              agent={pendingAgent}
              agents={agents}
              onAgentPick={pickAgent}
            />
          </EmptyState>
        )}
      </main>

      <SettingsPanel
        panel={panel}
        sessionDirectory={activeSession?.location?.directory}
        providerView={providerView}
        onClose={() => setPanel(null)}
      />

      {pair && <PairSheet onClose={() => setPair(false)} />}
      {changeConn && <ConnectScreen onCancel={() => setChangeConn(false)} />}

      {welcome && (
        <Welcome
          models={models}
          pendingModel={
            pendingModel
              ? { id: pendingModel.id, providerID: pendingModel.providerID, variant: pendingModel.variants[0]?.id }
              : undefined
          }
          onModelPick={pickModel}
          onProviders={() => {
            setWelcome(false)
            setProviderView("oauth")
            setPanel("providers")
          }}
          onApiKey={() => {
            setWelcome(false)
            setProviderView("key")
            setPanel("providers")
          }}
          onClose={() => setWelcome(false)}
        />
      )}

      <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />
    </div>
  )
}

/* ---------- tiny debounce ---------- */

function debounce<T extends () => Promise<void>>(fn: T, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void fn(), ms)
  }
}
