# OpenCode client

A standalone web app that is a genuine remote for the OpenCode sessions on
your PC: list sessions, watch one stream live (the same one the desktop is
in), send prompts, switch model and agent (Build/Plan), interrupt a running
turn — the same session, two screens.

Built on `@opencode/client`, OpenCode's official TypeScript client, speaking
its HTTP API directly — no scraping, no shims.

## Run it

Requires **Node 18+** and the OpenCode CLI running on this machine
(`npm i -g opencode-ai`, then start `opencode`).

```sh
cd client
npm install
npm run dev
```

Vite serves on all interfaces and proxies `/api` to OpenCode's background
service (URL + auth read from `~/.local/state/opencode/service.json`), so:

- **On the PC**: open `http://localhost:5173`
- **On the phone** (same Wi-Fi): open `http://<pc-ip>:5173`
  - *Phone can't connect?* Allow Node.js through your firewall when Windows
    asks on first start (or in Windows Security → Firewall → Allow an app).
- **Through a tunnel** (ngrok and friends): put your public hostname in
  `client/.env.local` — `ALLOWED_HOSTS=my-tunnel.ngrok-free.dev` (comma-separate
  several) — and restart `npm run dev`. The file is gitignored; nothing
  personal is committed.

The service URL changes when the background service restarts — Vite reads it
at dev-server start, so restart `npm run dev` after restarting OpenCode.

### How syncing works (there's nothing to pair)

The app talks to the **same OpenCode service your TUI uses**. Sessions live
in OpenCode's own storage, so both windows show the same list and the same
live turns — open one here, and it's the one on the desktop. The dot in the
header tells you the connection state ("live"). Pairing (URL + password, or
the QR flow) only exists for the hosted/downloaded variants, where the app
isn't behind the dev proxy.

### First run

On first visit the app shows a welcome with the three ways to get a working
model:

1. **Pick a model** — the `opencode` provider's models are free (no account,
   no keys); they're grouped as "Free · no account" in the picker.
2. **Use your subscription** — ⋮ → Providers → sign in with Claude
   (Pro/Max) or ChatGPT (Codex). OAuth in the browser, not API keys.
3. **Bring an API key** — ⋮ → Providers → search the provider, paste the
   key. It's stored in OpenCode's own credential store on your desktop,
   never in the browser.

The welcome appears once; "Got it" dismisses it for good.

## Security

**What protects you:** OpenCode enforces a random 32-byte password on every
service start. This app never weakens that: the dev path keeps the password
on your machine only (Vite injects it; the browser never sees it), there are
no cookies (nothing for a malicious site to ride), and all rendered content
is React-escaped — agent output, tool logs and markdown are never raw HTML.
The pairing link carries credentials in its URL fragment, which browsers
never send to servers, and the app clears it from the address bar on load.

**Trust model — the two rules that matter:**

1. **Run the dev server on networks you trust.** `npm run dev` opens the app
   to your Wi-Fi with your OpenCode credentials attached — that's what makes
   the phone work, and it means anyone on the same network can use your
   OpenCode. Home Wi-Fi: fine. Coffee shop: don't, or tunnel it (below).
2. **Away from home, use an encrypted path.** The built-in remote tunnel
   (OpenCode 2.0.26+) or Tailscale wrap the connection in TLS; plain LAN
   HTTP sends the password unencrypted (sniffable on hostile networks).

Smaller notes: in the hosted/downloaded variants the password lives in the
browser's localStorage (device-local — don't pair on a shared machine), and
a pairing QR is a bearer credential — anyone who sees it has your password
until the service restarts.

## Ship it: two GitHub-only paths, nothing to host

The built app is static files — there is no backend, and no secrets ship
inside it (each user's connection lives in their own browser). Open source
by construction: the repo *is* the distribution. Users still run OpenCode
itself (`npm i -g opencode-ai`) — the CLI *is* the server.

### 1. GitHub Pages — people just open a URL

Push to GitHub, then Settings → Pages → Source: **GitHub Actions**. Every
push to `main` deploys the app to `https://<you>.github.io/<repo>/`
(workflow included).

One browser rule to know: a page served over **HTTPS cannot call a plain
`http://192.168.x.x` address** (mixed content). So pair the hosted app with
an HTTPS-reachable OpenCode — the built-in remote tunnel on OpenCode
2.0.26+ (`opencode service set remote true` → a public HTTPS URL) or
`tailscale serve`. Both work from anywhere, home Wi-Fi included.

### 2. GitHub Releases — people download ONE file

`npm run build:single` inlines the entire app into a single ~350 KB HTML
file (`dist-single/index.html`). Attach it to a GitHub Release (the
workflow does it on `v*` tags, named `agentlink.html`). A user downloads
it, double-clicks it, and connects to their own:

```sh
opencode serve --hostname 0.0.0.0 --cors null
```

A `file://` page has no mixed-content restriction — verified: the
downloaded file talks to OpenCode on the LAN with no browser barriers. This
is the cleanest same-Wi-Fi path, and it works fully offline-as-artifact.

### Setup is the same either way

Enter the server URL + password once (the server prints both as it
starts) — or zero typing: connect on a PC browser, **⋮ → Pair phone**, scan
the QR. The pairing link carries the connection in its fragment, connects
automatically, and clears itself from the address bar. The password never
leaves the user's devices.

Developing locally stays as it is — in dev the app auto-connects through the
Vite proxy and never shows the connect screen.

## What it covers

| Feature | API |
|---|---|
| Session list (grouped, live) | `session.list` + `session.created/deleted` events |
| Session sync | `event.subscribe` — live-only, refetch on reconnect |
| Session switch / delete | `session.list`, `session.remove` |
| New session | `session.create` |
| Send a message (steer) | `session.prompt({ delivery: "steer" })` |
| Stop a running turn | `session.interrupt` |
| Model switch | `session.switchModel` + `model.list` |
| Mode switch (Build/Plan) | `session.switchAgent` + `agent.list` |
| Live text | `session.text.delta` & friends → debounced refetch |

## Production use

The dev proxy is fine for personal use. For anywhere-access, put the built
app behind the same origin as an `opencode serve --hostname 0.0.0.0 --port
4096` (Tailscale recommended — see `docs/mobile-app-plan.md` M3), or add the
`--cors` flag and connect the app directly with a pairing token.

## Design notes

Deliberately its own thing — restrained graphite surfaces, one green accent,
16/24px radii, no gradients, no pill shapes. Hand-rolled CSS (~400 lines),
zero UI dependencies beyond React.
