/**
 * Bring-your-own API key: search an integration, paste a key, store it in
 * OpenCode's credential store (activated immediately). The key lives on the
 * desktop in OpenCode's own storage — this app only relays it, it is never
 * persisted in the browser.
 */
import { useMemo, useState } from "react"
import { client } from "./api"

type Integration = {
  id: string
  name: string
  methods?: Array<{ type?: string }>
}

export function ApiKeySection({ integrations }: { integrations: Integration[] }) {
  const keyable = useMemo(
    () =>
      integrations
        .filter((i) => !i.id.startsWith("mcp_"))
        .filter((i) => (i.methods ?? []).some((m) => m.type === "key"))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [integrations],
  )
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Integration | null>(null)
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return keyable
      .filter(
        (i) =>
          i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q),
      )
      .slice(0, 8)
  }, [keyable, query])

  const save = async () => {
    if (!selected || !key.trim()) return
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      await client.credential.create({
        integrationID: selected.id,
        value: { type: "key", key: key.trim() },
        activate: true,
      })
      setSaved(`Saved — a key for ${selected.name} is now active.`)
      setSelected(null)
      setKey("")
      setQuery("")
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="apikey">
      <div className="apikey-head">Use an API key</div>
      {!selected ? (
        <>
          <input
            className="apikey-search"
            placeholder="Search providers — Anthropic, OpenAI, Google, DeepSeek…"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          {results.length > 0 && (
            <div className="apikey-results">
              {results.map((i) => (
                <button
                  key={i.id}
                  className="picker-item"
                  onClick={() => {
                    setSelected(i)
                    setQuery("")
                    setSaved(null)
                    setError(null)
                  }}
                >
                  <span className="picker-item-name">{i.name}</span>
                  <span className="picker-item-provider">{i.id}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="apikey-form">
          <div className="apikey-target">
            {selected.name} <span>{selected.id}</span>
          </div>
          <input
            className="apikey-input"
            type="password"
            placeholder="Paste the API key"
            value={key}
            autoComplete="off"
            autoFocus
            onChange={(e) => setKey(e.target.value)}
          />
          <div className="apikey-actions">
            <button
              className="btn-ghost"
              onClick={() => {
                setSelected(null)
                setKey("")
                setError(null)
              }}
            >
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={busy || !key.trim()}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save key"}
            </button>
          </div>
        </div>
      )}
      {saved && <div className="apikey-saved">{saved}</div>}
      {error && <div className="panel-error">{error}</div>}
    </div>
  )
}
