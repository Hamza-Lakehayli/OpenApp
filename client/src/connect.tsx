/**
 * Connect + pair: the screens that bind this app to one OpenCode service.
 * The connect screen is the first run (or a changed password); the pair
 * sheet renders a QR that hands the connection to another device.
 */
import { useState } from "react"
import { OpenCode } from "@opencode/client"
import { renderSVG } from "uqr"
import {
  encodeConnection,
  loadConnection,
  normalizeUrl,
  saveConnection,
  type ConnectionConfig,
} from "./connection"
import { XMarkIcon } from "@heroicons/react/20/solid"

/** Human sense from a failed probe: CORS-blocked and unreachable both throw bare. */
function connectError(err: unknown): string {
  const e = err as { status?: number; message?: string }
  const text = `${e?.status ?? ""} ${e?.message ?? ""}`
  if (e?.status === 401 || /401|unauthor/i.test(text))
    return "Wrong password — it's printed in the terminal where the server started."
  return "Can't reach the server. Check the address, that `opencode serve` is running, and that it was started with `--cors` including this app's address."
}

export function ConnectScreen({ onCancel }: { onCancel?: () => void }) {
  const existing = loadConnection()
  const [url, setUrl] = useState(existing?.url ?? "")
  const [password, setPassword] = useState(existing?.password ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    const cfg: ConnectionConfig = { url: normalizeUrl(url), password: password.trim() }
    if (!cfg.url) {
      setError("Enter the server address.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const probe = OpenCode.make({
        baseUrl: cfg.url,
        headers: cfg.password
          ? { authorization: `Basic ${btoa(`opencode:${cfg.password}`)}` }
          : undefined,
      })
      await probe.server.info()
      saveConnection(cfg)
      // full reload: every module-level binding boots on the new connection
      window.location.reload()
    } catch (err) {
      setBusy(false)
      setError(connectError(err))
    }
  }

  return (
    <div className="connect-host">
      <div className="connect-card">
        <div className="connect-brand">agentlink</div>
        <h1>Connect to OpenCode</h1>
        <p className="connect-sub">A remote for your own <code>opencode serve</code>.</p>

        <label className="connect-label">
          Server address
          <input
            className="connect-input"
            value={url}
            placeholder="http://192.168.1.20:4096"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <label className="connect-label">
          Password
          <input
            className="connect-input"
            type="password"
            value={password}
            placeholder="printed when the server starts"
            autoComplete="off"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <div className="connect-error">{error}</div>}

        <button className="btn-primary connect-go" disabled={busy} onClick={() => void connect()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        {onCancel && (
          <button className="btn-ghost connect-cancel" onClick={onCancel}>
            Cancel
          </button>
        )}

        <div className="connect-help">
          <p>On the machine with your projects, run:</p>
          <pre>
            npm i -g opencode-ai{"\n"}
            opencode serve --hostname 0.0.0.0 --cors {location.protocol === "file:" ? "null" : window.location.origin}
          </pre>
          <p>
            The URL and password are printed as soon as the server starts. Same
            Wi-Fi (or Tailscale) and you're in.
          </p>
        </div>
      </div>
    </div>
  )
}

/** The pairing QR: opens this app on another device, already connected. */
export function PairSheet({ onClose }: { onClose: () => void }) {
  const cfg = loadConnection()
  const link = cfg
    ? `${window.location.origin}${window.location.pathname}#conn=${encodeConnection(cfg)}`
    : null
  const svg = link ? renderSVG(link, { ecc: "M", border: 1 }) : ""

  return (
    <>
      <div className="scrim-high" onClick={onClose} />
      <div className="viewer-host" role="dialog" aria-modal="true" aria-label="Pair a phone">
        <div className="viewer-head">
          <h3>Pair a phone</h3>
          <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose}>
            <XMarkIcon />
          </button>
        </div>
        {link ? (
          <div className="pair-body">
            <div className="pair-qr" dangerouslySetInnerHTML={{ __html: svg }} />
            <p>
              Scan with the phone's camera — it opens this app already
              connected. The link carries this device's stored password and
              never leaves your devices.
            </p>
            {location.protocol === "file:" && (
              <p className="pair-note">
                This copy runs from a file on this PC, so a phone can't open
                its link — pair over the hosted version instead.
              </p>
            )}
          </div>
        ) : (
          <p className="pair-body">Not connected to a server yet.</p>
        )}
      </div>
    </>
  )
}
