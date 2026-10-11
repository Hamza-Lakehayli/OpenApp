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
cd copilot2phone/client
npm install
npm run dev
```

- **On the PC**: open `http://localhost:5173`
- **On the phone** (same Wi-Fi): open `http://<pc-ip>:5173`

The full setup guide — first-run walkthrough, providers (free models, OAuth
subscriptions, API keys), tunneling, and shipping options (GitHub Pages or a
single downloadable HTML file) — lives in
[`client/README.md`](client/README.md).

## What's here

```
client/    the app (React + Vite, TypeScript)
docs/      architecture report and animation profile
.github/   deploy workflow: GitHub Pages + single-file Release
```

On first launch the app walks you through picking a model (OpenCode ships
free ones — no account needed) and connecting your subscriptions.
