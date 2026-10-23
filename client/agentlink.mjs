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
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { Readable } from "node:stream"
import { randomUUID } from "node:crypto"
import { renderANSI, renderSVG } from "uqr"
import webpush from "web-push"

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

// content hash of the bundle — stamped into the served page (so a page knows
// which build it IS) and answered at /_agentlink/build (so it can compare)
const buildHash = () =>
  [...Buffer.from(serveHtml())].reduce((a, b) => (a * 33 + b) & 0xffffffff, 17).toString(36)
const htmlWithStamp = () =>
  serveHtml().replace(
    "</head>",
    `<meta name="agentlink-build" content="${buildHash()}">\n</head>`,
  )

/* ---------- phone → PC file drop ---------- */

// files picked on the phone are uploaded here, then attached to prompts by
// their PC path (the TUI's own paste works the same way: a local temp file)
const uploadsDir = join(here, "uploads")
try {
  // prune anything older than 30 days at boot
  for (const f of readdirSync(uploadsDir)) {
    const p = join(uploadsDir, f)
    if (Date.now() - statSync(p).mtimeMs > 30 * 864e5) rmSync(p, { force: true })
  }
} catch {}

/* ---------- push: nudge the phone when the agent needs you ---------- */

/*
   Web Push, served by the launcher itself: the OpenCode session events say
   when a turn chain ends or a permission needs a decision; the launcher
   forwards those moments to every subscribed device via a VAPID-signed
   push (the page does NOT need to be open — the launcher holds its own
   event stream). Keys + subscriptions live in .agentlink-push.json
   (gitignored).

   The watcher reads its events from the service on the next tick (the
   service block below initializes on module load, so a direct read here
   would see the binding before init).
*/

const pushFile = join(here, ".agentlink-push.json")
let pushState = (() => {
  try {
    return JSON.parse(readFileSync(pushFile, "utf8"))
  } catch {
    return {}
  }
})()
if (!pushState.keys?.privateKey) {
  pushState.keys = webpush.generateVAPIDKeys()
  pushState.subs = pushState.subs ?? []
  writeFileSync(pushFile, JSON.stringify(pushState))
}
webpush.setVapidDetails(
  "mailto:agentlink@localhost",
  pushState.keys.publicKey,
  pushState.keys.privateKey,
)

function savePush() {
  writeFileSync(pushFile, JSON.stringify(pushState))
}

// every subscription's push payload carries the tunnel URL to open;
// no tunnel, no point in pushing
async function sendPush(title, body, tag) {
  if (!phoneUrl || !pushState.subs?.length) {
    console.log(`  push skipped: phoneUrl=${!!phoneUrl} subs=${pushState.subs?.length ?? 0}`)
    return
  }
  console.log(`  push → "${title}" → ${pushState.subs.length} device(s): ${body.slice(0, 60)}`)
  const payload = JSON.stringify({ title, body, url: phoneUrl, tag })
  for (const s of [...pushState.subs]) {
    // FCM blips (TLS drops etc.) — one retry before giving up on a device
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // high urgency + TTL: tell Android's battery bot this nudge is worth
        // lighting up the screen for (doze defers normal-priority pushes)
        await webpush.sendNotification(s, payload, { TTL: 7200, urgency: "high" })
        console.log(`  push ok → ${s.endpoint.slice(0, 60)}`)
        break
      } catch (err) {
        // 404/410: gone — unsubscribe it; a bad key blob can never send either
        const gone =
          err.statusCode === 404 ||
          err.statusCode === 410 ||
          /subscription (p256dh|auth)|used as the key|public key/i.test(String(err.message ?? err))
        if (gone) {
          console.log(`  push: pruning unreachable sub (${err.statusCode ?? err.message?.slice(0, 40)})`)
          pushState.subs = pushState.subs.filter((x) => x.endpoint !== s.endpoint)
          savePush()
          break
        }
        if (attempt === 1) {
          console.log(`  push failed (still) (${err.statusCode}): ${String(err.message ?? err).slice(0, 110)}`)
        } else {
          await new Promise((r) => setTimeout(r, 1500))
        }
      }
    }
  }
}

/* the watcher: one SSE connection to the OpenCode service, mirrored
   logic from the app — execution.* spans = "the agent is working",
   its end = "waiting for you", permission.asked = "needs approval" */

const busy = new Map() // sessionID → true (execution span running)
const idleTimers = new Map() // sessionID → notify delay handle (queued turns
// may start right after an execution ends; the delay absorbs the ping-pong)

function trackEvent(type, data) {
  // interactive question: the session is now blocked on the user. The event
  // nests the form ({ form: {...} }) so it needs handling before the
  // top-level sessionID guard.
  if (type === "form.created") {
    const form = data?.form ?? data?.properties?.form ?? data
    if (form?.sessionID) void notifyQuestion(form.sessionID, form)
    return
  }
  const sid = data?.sessionID ?? data?.properties?.sessionID
  if (!sid) return
  if (type === "session.execution.started") {
    const t = idleTimers.get(sid)
    if (t) { clearTimeout(t); idleTimers.delete(sid) }
    busy.set(sid, Date.now())
    return
  }
  const ended =
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted"
  if (ended && busy.has(sid)) {
    console.log(`  push: turn chain ended (${type}) ${sid.slice(-8)}`)
    busy.delete(sid)
    idleTimers.set(
      sid,
      setTimeout(() => {
        idleTimers.delete(sid)
        notifyTurnEnd(sid)
      }, 1500),
    )
    return
  }
  if (type === "permission.asked") {
    void notifyAsk(sid, data)
  }
}

async function sessionTitle(sid) {
  try {
    const svc = service ?? readService()
    const r = await fetch(`${svc.url}/api/session/${sid}`, {
      headers: { authorization: svc.basic },
    })
    return (await r.json())?.data?.title ?? "OpenCode"
  } catch {
    return "OpenCode"
  }
}

async function lastText(sid) {
  try {
    const svc = service ?? readService()
    const r = await fetch(`${svc.url}/api/session/${sid}/message`, {
      headers: { authorization: svc.basic },
    })
    const list = (await r.json())?.data ?? []
    // order isn't chronological in practice — find the newest assistant text
    const last = list
      .filter((m) => m.type === "assistant")
      .sort((a, b) => (a?.time?.created ?? 0) - (b?.time?.created ?? 0))
      .pop()
    if (!last) return ""
    // content parts rule the wire ({type:"text",text}); keep parts as fallback
    const fromParts = (last.content ?? last.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(" ")
    return (fromParts || last.payload?.text || "").slice(0, 140)
  } catch {
    return ""
  }
}

async function notifyTurnEnd(sid) {
  const [title, snippet] = await Promise.all([sessionTitle(sid), lastText(sid)])
  sendPush(
    title,
    snippet ? `Finished — ${snippet}` : "Finished — waiting for you",
    "turn:" + sid,
  )
}

async function notifyAsk(sid, data) {
  const p = data?.properties ?? data ?? {}
  const what =
    [p.permission?.title, p.title, p.permission?.type, p.type]
      .find((x) => typeof x === "string" && x.trim()) ?? "your approval"
  sendPush(await sessionTitle(sid), `Needs ${what}`, "ask:" + sid)
}

async function notifyQuestion(sid, form) {
  const field = form?.fields?.[0]
  const what = field?.title ?? form?.title ?? "a question"
  const detail = field?.description ? ` — ${String(field.description).slice(0, 120)}` : ""
  sendPush(await sessionTitle(sid), `Question: ${what}${detail}`, "ask:" + sid)
}

function watchEvents() {
  const svc = service ?? readService()
  if (!svc) {
    setTimeout(watchEvents, 8000)
    return
  }
  // NOTE: the service routes everything under /api (the proxy forwards the
  // prefix untouched — /api/session here, not /session)
  fetch(`${svc.url}/api/event`, {
    headers: { authorization: svc.basic, accept: "text/event-stream" },
  }).then(async (up) => {
    if (!up.ok || !up.body) throw new Error("event stream unavailable")
    console.log("  watching sessions for ask-me / turn-end moments…")
    const reader = up.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.startsWith("data:")) continue
        try {
          const ev = JSON.parse(line.slice(5).trim())
          trackEvent(ev.type, ev.properties ?? ev.payload ?? ev.data ?? {})
        } catch {}
      }
    }
  }).catch(() => {}).finally(() => {
    // the service can restart (new port/password) — re-watch
    setTimeout(watchEvents, 5000)
  })
}
// next tick so the service block below has booted
setTimeout(watchEvents, 1500)

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
    if (url.pathname === "/_agentlink/upload" && req.method === "POST") {
      // raw bytes in, PC path out — the agent reads the file from there
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      if (!body.length || body.length > 64 * 1024 * 1024) {
        res.writeHead(body.length ? 413 : 400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: body.length ? "file too large (64MB max)" : "empty upload" }))
        return
      }
      const raw = url.searchParams.get("name") || "upload.bin"
      const safe = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").slice(-120) || "upload.bin"
      try {
        mkdirSync(uploadsDir, { recursive: true })
        const file = join(uploadsDir, `${Date.now().toString(36)}-${safe}`)
        writeFileSync(file, body)
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        res.end(JSON.stringify({ path: file, name: safe, size: body.length }))
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "could not save: " + String(err).slice(0, 120) }))
      }
      return
    }
    if (url.pathname === "/_agentlink/build") {
      // for the app's new-build-on-reopen check (stale chrome boot caches)
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(JSON.stringify({ hash: buildHash() }))
      return
    }
    if (url.pathname === "/_agentlink/push/vapid") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(JSON.stringify({ publicKey: pushState.keys.publicKey }))
      return
    }
    if (url.pathname === "/_agentlink/push/subscribe" && req.method === "POST") {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      try {
        const { subscription } = JSON.parse(Buffer.concat(chunks).toString())
        if (!subscription?.endpoint) throw new Error("bad subscription")
        // one subscription per endpoint (re-subscribes refresh it)
        pushState.subs = pushState.subs.filter((x) => x.endpoint !== subscription.endpoint)
        pushState.subs.push(subscription)
        savePush()
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        res.end(JSON.stringify({ ok: true, count: pushState.subs.length }))
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: String(err).slice(0, 120) }))
      }
      return
    }
    if (url.pathname === "/_agentlink/push/unsubscribe" && req.method === "POST") {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      try {
        const { endpoint } = JSON.parse(Buffer.concat(chunks).toString())
        pushState.subs = pushState.subs.filter((x) => x.endpoint !== endpoint)
        savePush()
      } catch {}
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(JSON.stringify({ ok: true, count: pushState.subs?.length ?? 0 }))
      return
    }
    if (url.pathname === "/_agentlink/push/test" && req.method === "POST") {
      await sendPush("Agentlink test", "If you can read this, push works end to end.", "test")
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(JSON.stringify({ ok: true, count: pushState.subs.length }))
      return
    }
    if (url.pathname === "/sw.js") {
      // the push service worker — plain file, no build step
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" })
      res.end(readFileSync(join(here, "sw.js")))
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
    res.end(htmlWithStamp().replace("</body>", bannerHtml + "</body>"))
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
