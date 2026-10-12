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
import { readFileSync, existsSync, statSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { Readable } from "node:stream"
import { randomUUID } from "node:crypto"
import { renderANSI, renderSVG } from "uqr"

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8170)
const KEY = randomUUID().replaceAll("-", "").slice(0, 12)

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
const { url: serviceUrl, password } = JSON.parse(readFileSync(serviceFile, "utf8"))
if (!serviceUrl || !password) {
  console.error("service.json is missing url/password — is OpenCode running?")
  process.exit(1)
}
const basic = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

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

async function proxy(req, res, url) {
  const target =
    serviceUrl.replace(/\/$/, "") + url.pathname + url.search
  const headers = { ...req.headers }
  delete headers.host
  delete headers["accept-encoding"] // upstream compresses; undici auto-decompresses
  delete headers.cookie
  delete headers.origin
  delete headers.referer
  headers.authorization = basic
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = ["GET", "HEAD"].includes(req.method)
    ? undefined
    : Buffer.concat(chunks)
  const up = await fetch(target, {
    method: req.method,
    headers,
    body,
    // @ts-ignore duplex is required by undici for streaming bodies
    duplex: "half",
  })
  const out = { ...Object.fromEntries(up.headers) }
  delete out["content-length"]
  delete out["content-encoding"] // already decompressed
  delete out["transfer-encoding"]
  res.writeHead(up.status, out)
  if (up.body) Readable.fromWeb(up.body).pipe(res)
  else res.end()
}

let phoneUrl = null // set once ngrok reports its public URL

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
      ...(needsCookie ? { "set-cookie": `agentlink=${KEY}; Path=/; HttpOnly; SameSite=Lax` } : {}),
    })
    res.end(serveHtml().replace("</body>", bannerHtml + "</body>"))
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
    res.end("agentlink proxy error: " + String(err).slice(0, 200))
  }
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
  console.log(`  opencode:  ${serviceUrl}`)
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

  // ngrok, if it's installed
  const ngrok = spawn("ngrok", ["http", String(PORT)], { stdio: "ignore" })
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
