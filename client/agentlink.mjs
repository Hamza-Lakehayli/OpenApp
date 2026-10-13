#!/usr/bin/env node
/**
 * agentlink — one command instead of `npm run dev`:
 *
 *   npm run agentlink
 *
 * Serves the built app on localhost, proxies /api to your OpenCode service
 * (the password never leaves this machine), opens your browser already
 * connected, and — if the ngrok CLI is installed — prints a QR that pairs
 * your phone over an HTTPS tunnel. No CORS flags, no firewall prompts,
 * no password on the phone.
 *
 * Access is gated by a random key: the tunnel URL without it serves nothing.
 */
import http from "node:http"
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { Readable } from "node:stream"
import { randomUUID } from "node:crypto"
import { renderANSI, renderSVG } from "uqr"

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8170)
// the access key is generated ONCE and stored next to the launcher, so the
// phone pairing survives restarts (gitignored — never committed)
const keyFile = join(here, ".agentlink-key")
let KEY = existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : ""
if (!KEY) {
  KEY = randomUUID().replaceAll("-", "").slice(0, 24)
  writeFileSync(keyFile, KEY)
}

/* ---------- the built app ---------- */

const htmlPath = join(here, "dist-single", "index.html")
if (!existsSync(htmlPath)) {
  console.log("Building the app once (npm run build:single)…")
  const npm = platform === "win32" ? "npm.cmd" : "npm"
  const r = spawnSync(npm, ["run", "build:single"], { cwd: here, stdio: "inherit" })
  if (r.status !== 0 || !existsSync(htmlPath)) {
    console.error("Build failed — run `npm run build:single` and retry.")
    process.exit(1)
  }
}
const serveHtml = () => readFileSync(htmlPath, "utf8") // fresh on every request

/* ---------- your OpenCode service ---------- */

const serviceFile = join(homedir(), ".local", "state", "opencode", "service.json")
if (!existsSync(serviceFile)) {
  console.error("No OpenCode service found (~/.local/state/opencode/service.json).")
  console.error("Start OpenCode first: run `opencode`, or `opencode serve`.")
  process.exit(1)
}
let service = readService()

function readService() {
  try {
    const raw = JSON.parse(readFileSync(serviceFile, "utf8"))
    if (!raw.url || !raw.password) throw new Error("missing url/password")
    return {
      url: raw.url.replace(/\/$/, ""),
      basic: "Basic " + Buffer.from(`opencode:${raw.password}`).toString("base64"),
    }
  } catch {
    return null
  }
}

/* ---------- the server: static + credential-injecting proxy ---------- */

function authorized(req, url) {
  // a browser on this machine is trusted; tunnel traffic is not
  // (ngrok marks forwarded requests with X-Forwarded-* headers)
  const tunneled = req.headers["x-forwarded-host"] || req.headers["x-forwarded-proto"]
  if (!tunneled) return true
  const cookie = (req.headers.cookie || "")
    .split(/;\s*/)
    .some((c) => c === `agentlink=${KEY}`)
  return cookie || url.searchParams.get("key") === KEY
}

let lastServiceStart = 0

function ensureOpencode() {
  // start a background OpenCode service if none is reachable (idempotent)
  const now = Date.now()
  if (now - lastServiceStart < 30000) return
  lastServiceStart = now
  const exe = platform === "win32" ? "opencode.cmd" : "opencode"
  try {
    const where = spawnSync(platform === "win32" ? "where" : "which", [exe])
    const full = where.stdout.toString().split(/\r?\n/)[0].trim()
    if (!full) return
    spawn(full, ["service", "start"], { detached: true, stdio: "ignore" }).unref()
    console.log("  opencode service was down — starting it…")
  } catch {}
}

async function proxy(req, res, url) {
  const send = async (svc) => {
    const target = svc.url + url.pathname + url.search
    const headers = { ...req.headers }
    delete headers.host
    delete headers["accept-encoding"] // upstream compresses; undici auto-decompresses
    delete headers.cookie
    delete headers.origin
    delete headers.referer
    headers.authorization = svc.basic
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = ["GET", "HEAD"].includes(req.method)
      ? undefined
      : Buffer.concat(chunks)
    return fetch(target, {
      method: req.method,
      headers,
      body,
      // @ts-ignore duplex is required by undici for streaming bodies
      duplex: "half",
    })
  }
  if (!service) ensureOpencode()
  let up = service ? await send(service) : null
  if (!up || up.status === 401 || up.status === 503) {
    // the OpenCode service may have restarted with a new password or port —
    // re-read service.json (and revive the service if it died), retry once
    ensureOpencode()
    service = readService()
    if (service) up = await send(service)
  }
  if (!up) {
    res.writeHead(502, { "content-type": "text/plain" })
    res.end("agentlink: OpenCode service unreachable")
    return
  }
  const out = { ...Object.fromEntries(up.headers) }
  delete out["content-length"]
  delete out["content-encoding"] // already decompressed
  delete out["transfer-encoding"]
  res.writeHead(up.status, out)
  if (up.body) Readable.fromWeb(up.body).pipe(res)
  else res.end()
}

let phoneUrl = null // set once ngrok reports its public URL

// resolve absolute paths once - service contexts may have a thin PATH
function resolveCmd(name) {
  const r = spawnSync(platform === "win32" ? "where" : "which", [name])
  return r.status === 0 ? r.stdout.toString().split(/\r?\n/)[0].trim() : null
}
const opencodePath = resolveCmd(platform === "win32" ? "opencode.cmd" : "opencode")
const ngrokPath = resolveCmd("ngrok")

// make sure an OpenCode service exists at boot, so the phone works
// even before the TUI is opened (idempotent - no-op if already running)
if (opencodePath) {
  const s = spawn(opencodePath, ["service", "start"], { detached: true, stdio: "ignore" })
  s.on("error", () => {})
  s.unref()
}

const bannerHtml = readFileSync(join(here, "phone-banner.html"), "utf8")

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost")
    if (!authorized(req, url)) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8" })
      res.end(
        "<body style=\"font-family:sans-serif;padding:2rem\">agentlink is running on this machine.<br>This public URL needs its access key - open the link printed in the agentlink window (the one ending in <code>?key=</code>).",
      )
      return
    }
    if (url.pathname === "/_agentlink/info") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(JSON.stringify({ phoneUrl }))
      return
    }
    if (url.pathname === "/_agentlink/qr.svg") {
      if (!phoneUrl) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" })
      res.end(renderSVG(phoneUrl, { border: 1 }))
      return
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      await proxy(req, res, url)
      return
    }
    const needsCookie = !(req.headers.cookie || "").includes(`agentlink=${KEY}`)
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...(needsCookie ? { "set-cookie": `agentlink=${KEY}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` } : {}),
    })
    res.end(serveHtml().replace("</body>", bannerHtml + "</body>"))
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
    res.end("agentlink proxy error: " + String(err).slice(0, 200))
  }
})

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("\n  Port " + PORT + " is busy — agentlink is probably already")
    console.error("  running in another window. Close that one first, or:")
    console.error("    set PORT=8171 && npm run agentlink")
  } else {
    console.error("server error:", err.message)
  }
  process.exit(1)
})

server.listen(PORT, "127.0.0.1", () => {
  const origin = `http://localhost:${PORT}`
  const conn = Buffer.from(
    JSON.stringify({ u: origin, p: "" }),
  ).toString("base64url")
  const localUrl = `${origin}/?key=${KEY}#conn=${conn}`
  console.log("")
  console.log("  agentlink running")
  console.log(`  local:     ${localUrl}`)
  console.log(`  opencode:  ${service ? service.url : readService()?.url ?? "?"}`)
  console.log("  opening your browser…")

  // the browser, already connected — a failed opener must never crash us
  try {
    const open =
      platform === "win32"
        ? spawn("rundll32", ["url.dll,FileProtocolHandler", localUrl], { detached: true, stdio: "ignore" })
        : spawn(platform === "darwin" ? "open" : "xdg-open", [localUrl], { detached: true, stdio: "ignore" })
    open.on("error", () => {})
    open.unref()
  } catch {
    console.log("  (couldn't auto-open the browser — visit the local URL above)")
  }

  // ngrok, if it's installed — its own visible window so it can be
  // inspected and killed independently of the app
  const ngrok =
    platform === "win32"
      ? spawn("cmd", ["/c", "start", "agentlink-ngrok", "cmd", "/k", ngrokPath || "ngrok", "http", String(PORT)], { stdio: "ignore" })
      : spawn(ngrokPath || "ngrok", ["http", String(PORT)], { stdio: "ignore" })
  ngrok.on("error", () => {
    console.log("")
    console.log("  ngrok not installed — phone over Wi-Fi needs the Vite dev")
    console.log("  server instead (npm run dev), or install ngrok and rerun:")
    console.log("    https://ngrok.com/download  →  ngrok config add-authtoken <token>")
  })
  ngrok.on("spawn", () => {
    let tries = 0
    const poll = setInterval(async () => {
      tries++
      try {
        const res = await fetch("http://127.0.0.1:4040/api/tunnels")
        const data = await res.json()
        const https = (data.tunnels ?? []).find((t) =>
          String(t.public_url ?? "").startsWith("https://"),
        )
        if (https) {
          clearInterval(poll)
          const publicUrl = https.public_url
          const phoneConn = Buffer.from(
            JSON.stringify({ u: publicUrl, p: "" }),
          ).toString("base64url")
          phoneUrl = publicUrl + "/?key=" + KEY + "#conn=" + phoneConn
          console.log("")
          console.log(`  phone (scan, or open): ${phoneUrl}`)
          console.log("")
          console.log(renderANSI(phoneUrl, { border: 1 }))
          console.log("  The tunnel URL grants full OpenCode access — share it")
          console.log("  like a password. Free ngrok shows a warning page first;")
          console.log("  click Visit once.")
        }
      } catch {
        if (tries > 240) clearInterval(poll)
      }
    }, 500)
  })

  console.log("")
  console.log("  Ctrl+C to stop.")
})
