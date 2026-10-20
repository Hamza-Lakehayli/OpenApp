# OpenApp

A phone-first web remote for [OpenCode](https://opencode.ai). It talks to the
OpenCode service running on your machine and shows the same sessions your
desktop TUI does — live: watch a turn stream in, send prompts, switch model
and agent, manage MCP servers, skills, providers and files, all from the
phone or any browser.

One OpenCode service, many windows: sessions are shared between the desktop
and this app in real time. There is no backend — the app is a static frontend
speaking OpenCode's own HTTP API.

## Quick start

Requires **Node 18+** and the OpenCode CLI on the machine with your projects.

```sh
npm i -g opencode-ai
opencode                 # keep it running (or: opencode serve)

git clone <this repo>
cd OpenApp
```

Then just **double-click `start-agentlink.bat`** (Windows) or run
`./start-agentlink.sh` (macOS/Linux) — first run installs dependencies,
after that it starts the app instantly, opens your browser already
connected, and sets up the phone QR if ngrok is installed.

- **On the PC**: open `http://localhost:5173`
- **On the phone** (same Wi-Fi): open `http://<pc-ip>:5173`

The full setup guide — first-run walkthrough, providers (free models, OAuth
subscriptions, API keys), tunneling, and the single downloadable HTML file —
lives in
[`client/README.md`](client/README.md).

## What's here

```
client/    the app (React + Vite, TypeScript)
docs/      architecture report and animation profile
.github/   release workflow: single-file Release on version tags
```

On first launch the app walks you through picking a model (OpenCode ships
free ones — no account needed) and connecting your subscriptions.

### How chat streams

Incoming messages are applied live from the server's event stream — deltas
mutate a per-session store in place, batched per animation frame. A full
history fetch (`limit=200&order=desc`) happens only when a session opens,
when the event stream reconnects, when a turn reaches its terminal state,
or when an event references a message the store hasn't seen; the merge rule
keeps stale fetches from clobbering newer streamed text. Older messages
beyond the 200-message window load when a reconciliation fetch happens —
a paginated "load older" control may come later.

Sent prompts get a client-generated `msg_…` id reused for the optimistic
bubble, the inbox item, the created user message and any retry, so a send
that reaches the server is always reconcilable by that id even when the
response never arrives. The reducer is unit-tested (`npm test`).
