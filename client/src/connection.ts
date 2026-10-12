/**
 * Connection config: where the user's OpenCode service lives and its
 * password. Stored in localStorage; a #conn= hash (from QR pairing)
 * overrides once and is stripped from the address bar.
 */
export type ConnectionConfig = { url: string; password: string }

const KEY = "agentlink.connection"

export function loadConnection(): ConnectionConfig | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const cfg = JSON.parse(raw) as Partial<ConnectionConfig>
    if (!cfg.url) return null
    return { url: cfg.url, password: cfg.password ?? "" }
  } catch {
    return null
  }
}

export function saveConnection(cfg: ConnectionConfig) {
  localStorage.setItem(KEY, JSON.stringify(cfg))
}

export function clearConnection() {
  localStorage.removeItem(KEY)
}

/** Accept "192.168.1.20:4096" as "http://192.168.1.20:4096"; trim trailing slashes. */
export function normalizeUrl(input: string): string {
  let url = input.trim()
  if (!url) return ""
  if (!/^https?:\/\//i.test(url)) url = "http://" + url
  return url.replace(/\/+$/, "")
}

/** ClientOptions for a connection — none means same-origin (the dev proxy). */
export function optionsFor(
  cfg: ConnectionConfig | null,
): { baseUrl: string; headers?: Record<string, string> } {
  if (!cfg) return { baseUrl: window.location.origin }
  const headers = cfg.password
    ? { authorization: `Basic ${btoa(`opencode:${cfg.password}`)}` }
    : undefined
  return { baseUrl: cfg.url, headers }
}

/* ---------- QR pairing: #conn=<base64url json> ---------- */

export function encodeConnection(cfg: ConnectionConfig): string {
  const json = JSON.stringify({ u: cfg.url, p: cfg.password })
  const bin = String.fromCharCode(...new TextEncoder().encode(json))
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function decodeConnection(encoded: string): ConnectionConfig | null {
  try {
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
    const bin = atob(b64)
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
    const cfg = JSON.parse(json) as { u?: string; p?: string }
    if (!cfg.u) return null
    return { url: cfg.u, password: cfg.p ?? "" }
  } catch {
    return null
  }
}

/**
 * Consume a #conn= hash: returns the paired config and strips the hash from
 * the address bar so the password doesn't linger in history or shares.
 */
export function connectionFromHash(): ConnectionConfig | null {
  const match = /^#conn=(.+)$/.exec(window.location.hash)
  if (!match) return null
  const cfg = decodeConnection(match[1])
  history.replaceState(null, "", window.location.pathname + window.location.search)
  if (cfg) saveConnection(cfg) // pairing must survive reloads
  return cfg
}

/**
 * The connection the app boots with: a pairing hash wins over the stored
 * config; nothing means same-origin, which in dev is the Vite proxy.
 */
export const initialConnection: ConnectionConfig | null = connectionFromHash() ?? loadConnection()
