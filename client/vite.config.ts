import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

/**
 * Dev proxy: the browser talks same-origin, and Vite forwards /api and /auth
 * to OpenCode's local background service with its credentials — the app needs
 * no token in the browser, and the phone reaches it over the LAN.
 *
 * The service URL + password live in ~/.local/state/opencode/service.json.
 * They change when the service restarts, so they are read at dev-server start.
 *
 * Tunneling (optional): to reach this dev server through ngrok or another
 * tunnel, put the public hostname in client/.env.local —
 *   ALLOWED_HOSTS=my-tunnel.ngrok-free.dev
 * (comma-separated for several). Nothing personal is committed.
 */
function opencodeService(): { target: string; password: string } {
  try {
    const file = resolve(homedir(), ".local/state/opencode/service.json")
    const raw = JSON.parse(readFileSync(file, "utf-8"))
    return { target: raw.url, password: raw.password }
  } catch {
    // no service running yet: fall back to the default serve port.
    return { target: "http://127.0.0.1:4096", password: "" }
  }
}

export default defineConfig(({ mode }) => {
  const service = opencodeService()
  const authHeaders = service.password
    ? {
        // OpenCode's own client uses HTTP Basic with username "opencode" and
        // the service password (read from the @opencode/client service module).
        authorization: `Basic ${btoa(`opencode:${service.password}`)}`,
      }
    : undefined

  // your tunnel hostname(s), never committed — see client/.env.local
  const env = loadEnv(mode, process.cwd(), "")
  const allowedHosts = (env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)

  return {
    base: "./",
    plugins: [react()],
    server: {
      host: true,
      ...(allowedHosts.length ? { allowedHosts } : {}),
      proxy: {
        "/api": { target: service.target, headers: authHeaders, changeOrigin: false },
        "/auth": { target: service.target, headers: authHeaders, changeOrigin: false },
        // file uploads go to the launcher, not OpenCode (it has no upload API)
        "/_agentlink": { target: "http://localhost:8170", changeOrigin: false },
      },
    },
  }
})
