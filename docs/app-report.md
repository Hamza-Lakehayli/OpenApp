# The app — how it works

A phone-approachable, remote OpenCode client. The OpenCode server runs on the
PC; this app is the client that talks to it — from the PC's browser or from a
phone over the LAN (or an ngrok tunnel). Sessions, chat, model picks, settings
and sign-ins are all live against the same OpenCode instance the desktop TUI
sees.

---

## 1. Architecture

```
Phone browser ──┐
                │   (LAN / ngrok — allowedHosts in vite.config.ts)
PC browser ─────┤
                ▼
        Vite dev server (npm run dev, port 5173)
                │  same-origin /api + /auth proxy — the browser never
                │  handles a token; the proxy injects HTTP Basic auth
                ▼
        OpenCode service (opencode serve --service)
        ├─ the HTTP API (sessions, chat, MCP, integrations, fs…)
        ├─ the event stream (GET /api/event, SSE — the live sync)
        ├─ MCP servers (playwright, chrome-devtools, context7, Github…)
        ├─ plugins (@openchamber/opencode-claude …)
        └─ storage (sessions, auth, config — all on the PC)
```

- **One client, one origin.** `src/api.ts` creates a single `OpenCode` client
  with `baseUrl: window.location.origin`. Vite's dev proxy forwards `/api` and
  `/auth` to the OpenCode service **with its credentials** (read from
  `~/.local/state/opencode/service.json` at dev-server start). In a
  production deploy behind a reverse proxy the same setup applies.
- **The service URL + password change when the service restarts**, so the
  dev server reads them at start — a service restart means a dev-server
  restart too.
- **Everything the app does is server-side state.** Sessions live on the PC;
  the phone is just a viewport onto them. Reload the app anywhere and the
  same session is there.

---

## 2. File map

| File | Role |
| --- | --- |
| `src/main.tsx` | Mounts `<App />`, imports the stylesheet. |
| `src/api.ts` | The single OpenCode client (same-origin) + type re-exports. |
| `src/App.tsx` | The app shell: data loading, the event pump, all actions (send/stop/archive/restore/picks), and the render tree. |
| `src/components.tsx` | Reusable views: model/agent pickers, tool/reasoning blocks, the chat list, the empty state, the sidebar drawer (drag gestures), the confirm dialog. |
| `src/settings.tsx` | The ⋮ menu + the three panels: MCP servers, Skills, Providers (OAuth). |
| `src/composer.tsx` | The message composer: agent + model pickers, auto-growing textarea, send/stop. |
| `src/markdown.tsx` | A small, dependency-free markdown renderer (React nodes, never raw HTML). |
| `src/types.ts` | Session/message types + `toChatItems` — flattens the API message stream into renderable chat items. |
| `src/recent.ts` | Recently-used models — localStorage-backed. |
| `src/anim.ts` | The animation profile — the single source of truth for motion (mirrored as CSS custom properties in `styles.css`). |
| `src/styles.css` | Design tokens (warm graphite, one green accent) + all styles. |

---

## 3. The app shell (`App.tsx`)

### Data loading

- `loadSessions` — `client.session.list()`; sets the live/offline banner from
  whether the call succeeded.
- `loadMessages(sessionID)` — `client.message.list({ order: "desc", limit: 200 })`,
  reversed into chronological order and flattened via `toChatItems`.
- `loadMeta` — models (`enabled`, non-deprecated), agents (non-subagent,
  non-hidden), and the active/running sessions map.

### The event pump — the live sync

One `client.event.subscribe()` iterator (SSE) runs for the app's lifetime:

- `session.created` / `session.deleted` → refresh the session list (debounced).
- `session.execution.started/succeeded/failed/interrupted` → update the
  running state (the green dot) + refresh.
- Anything content-shaped in the **open** session (`session.text.*`,
  `session.reasoning.*`, `session.tool.*`, `session.step.*`, usage updates,
  inbox deliveries) → re-render the open chat (debounced 250ms).

On a dropped stream it backs off 2s and resubscribes.

### Boot

On load: the most recent **non-archived** session is opened automatically;
archived ones stay tucked away. Meta (models/agents) loads in parallel.

### Actions

- **Send** — on the greeting screen the session is created by the first
  message (no empty sessions pile up); on an existing chat the user bubble is
  optimistic and the rest streams in. Delivery is `"steer"`.
- **Stop** — `client.session.interrupt`.
- **Model/agent picks** — on the greeting screen the choice is remembered
  (`pendingModel`/`pendingAgent`) and applied when the session is created; on
  an existing chat it switches via `switchModel`/`switchAgent`. Every pick
  also marks the model recently used.
- **Archive / restore / delete** — see §6.

---

## 4. Chat rendering (`types.ts` + `components.tsx`)

`toChatItems` flattens an assistant message's content parts into ordered
blocks:

- **text** → the markdown renderer (fenced code blocks with a language badge,
  inline code, bold/italic, links, headings, lists, blockquotes — all React
  nodes, no `dangerouslySetInnerHTML`).
- **reasoning** → a collapsed "Thinking" block.
- **tool** → a collapsed tool row: status dot (running/ok/error), the tool
  name, and the input/output when expanded. Outputs that are **files**
  (screenshots) render as images — see §7.

The chat auto-scrolls while streaming but stops fighting the user: if they
scroll up, the stick-to-bottom disengages until they return.

---

## 5. The sidebar drawer (`components.tsx`)

The sidebar is an **off-canvas drawer on every viewport** (desktop included —
that is what makes the slide possible):

- **Opens** via the ☰ button (240ms, `--ease-standard`), or **pulled open**
  with a left-to-right drag from the left edge (a 22px invisible
  `.sidebar-edge` strip with `touch-action: none`).
- **Closes** via a drag from inside the drawer (axis-locked after 6px, so
  vertical scrolls of the session list stay native via `touch-action: pan-y`),
  a tap on the scrim, selecting a session, or Esc.
- **Follows the finger 1:1** while dragging (the transition is off); on
  release it settles by distance (past 40% of the drawer width) or flick
  (velocity > 0.4 px/ms), springing to its resting place with the transition
  re-enabled. The scrim's opacity follows the drag.
- **Gesture tracking is document-level**, never `setPointerCapture` on
  pointerdown — capturing retargets the derived click to the drawer element,
  which eats taps on buttons inside it. A horizontal drag ending on a session
  row suppresses the row's click (a capture-phase click handler) so dragging
  closed never selects anything.

Sessions group by day ("Today" / "Month D"). The ✕ on a row **archives** —
see §6.

---

## 6. Archive — nothing is erased by default

- The ✕ on a session opens an in-app **confirm dialog** ("Archive session?").
  Confirming sets the session's `metadata.archived = Date.now()`.
- **PATCH replaces the whole metadata object**, so the flow is
  read-merge-write: `session.get` → spread the existing metadata → add
  `archived` → `session.update`. (Verified against the live API.)
- The sidebar tucks archived sessions under a collapsible **Archived** group:
  - tap a row → **restore** (the metadata loses the `archived` key; the
    session returns to the main list and is selected),
  - the ✕ there is **Delete forever** — behind a harder confirm, and the only
    path that calls `session.remove`.
- Boot skips archived sessions when picking the one to reopen.

The confirm dialog is the shared primitive (`ConfirmDialog` in
`components.tsx`): scrim + card + Cancel/Confirm, Esc closes.

---

## 7. Playwright screenshots, inline

When an agent calls an image-producing tool (the playwright or
chrome-devtools MCP), the tool's output rides in the session's tool state as
`Tool.FileContent { uri, mime, name }`:

- `types.ts` `toolBlock` extracts those file parts into the tool block
  (`images: [{ uri, mime }]`).
- `ToolImage` resolves the uri three ways: **`data:` uris render directly**
  (playwright returns data URIs — the common case), **http(s) uris** render
  directly, and **file paths** fetch their bytes through
  `client.file.read` → Blob → object URL.
- **Tapping the image opens a lightbox** — the image fills the screen (dark
  scrim, ✕ affordance, `zoom-in`/`zoom-out` cursors); tap anywhere or Esc
  dismisses.

Verified end-to-end: a real agent turn calling the playwright MCP lands the
screenshot as a data-URI file part, and the app renders it inline.

---

## 8. Settings — the ⋮ menu and the three panels (`settings.tsx`)

### MCP servers

- Lists every configured server with a status dot (connected / failed /
  needs_auth / pending) and the error text when there is one.
- **Add / Edit** — a form with:
  - **Remote (URL)**: the url + a **headers** field (`KEY=value` per line) →
    `config.headers`. Remote servers authenticate with headers — GitHub's MCP
    takes `Authorization=Bearer <token>`. A token header also sets
    `oauth: false`, opting out of the OAuth dance. Editing a remote server
    whose stored config still carries environment variables shows a note:
    remote servers ignore them.
  - **Local (command)**: command + args, working directory, and the
    **environment** field (env vars are local-stdio only).
- **Persisting**: `mcp.add`/`mcp.remove` only touch the running service's
  memory, so every change is also written into the user's `opencode.json`
  (read-modify-write through the config layers — verified identical to the
  file) so it survives restarts.
- **Connect/Disconnect** per server; **Resources** lists each server's MCP
  resources.

### Skills

- Lists discovered skills (built-in ones are read-only).
- **Add** — writes a `SKILL.md` (name, description, instructions) into
  `<project>/.opencode/skills/<id>/SKILL.md` through the fs API.
- **View** — expands the SKILL.md body; **Remove** — runs the removal through
  the shell API (no fs/delete route).
- Skills scope to the open session's project.

### Providers (OAuth sign-ins)

- Lists every integration that offers an OAuth method (Claude Code, OpenAI ×3
  ChatGPT methods, GitHub Copilot, GitLab, DigitalOcean, Poe, Snowflake, xAI,
  OpenCode Console…), with its connections.
- **Sign in** drives the server's integration API end to end:
  1. `integration.oauth.connect({ integrationID, methodID, answer? })` —
     form-bearing methods (GitHub Copilot's deployment type, GitLab's
     instance URL) render their fields inline and honor `when`-conditions.
  2. The attempt card shows the **login URL** (opens the browser — on the
     phone it opens the phone's browser), the **device code** with a
     tap-to-copy chip when the flow is device-code based, and a **live
     countdown** — attempts live 10 minutes.
  3. The panel **polls** `integration.oauth.status` every 2s until the server
     sees the flow land (`complete`), then refreshes. A superseded/expired
     attempt answers 404, which ends the wait with an "expired — start
     again" note instead of polling forever.
- **Phone vs PC**: device-code methods (ChatGPT headless, xAI) complete from
  any browser — including the phone. Loopback-callback methods (ChatGPT
  browser, Antigravity) redirect to the PC's `localhost` — PC only.

---

## 9. Recently used models (`recent.ts`)

- The model picker splits into **"Recently used"** (up to 5) and
  **"All models"**.
- Tracking is localStorage-backed (`opencode-recent-models`, keyed by
  `providerID/id`, capped at 8), updated on every explicit pick **and**
  whenever the active session's model is observed — so the models you
  actually reach for sit at the top without any picks.

---

## 10. The animation profile (`anim.ts`)

Four rules, one source of truth:

1. Motion answers an action — nothing decorative.
2. Drags follow the finger 1:1 (transition off) and spring back with
   `--ease-standard`.
3. One easing per personality: `--ease-standard` for entrances/exits,
   `--ease-spring` only for small tactile pops.
4. `prefers-reduced-motion: reduce` collapses every duration to ~0.

Durations: `--anim-fast` 120ms (hovers, taps), `--anim-base` 180ms (menus,
scrims), `--anim-slow` 240ms (drawer, sheets). Keyframes: `fade-in`,
`pop-in`, `panel-in`, `spin`. Documented in `docs/animation-profile.md`.

---

## 11. The OpenCode service side (as configured on this machine)

- **Plugins** (`plugins` in `~/.config/opencode/opencode.json`):
  - `@openchamber/opencode-claude@1.3.8` — **loads**; adds the `claude-code`
    provider (6 models). Requests run through the local `claude` CLI, so it
    needs `claude auth login --claudeai` (Pro/Max plan — Claude Code has no
    free path). On Windows the plugin's model-list read hits a `cmd.exe`
    escaping issue and falls back to its cached list.
  - `@cortexkit/opencode-v2-antigravity-auth` — **not published to npm**
    (404); the entry is inert. Its model map IS registered
    (`providers.google.models` — 9 antigravity models under the `google`
    provider), so the models appear but fail on request until the plugin
    exists (no Google credentials, no routing).
  - `@iam-brain/opencode-codex-auth@1.10.0` — **fails to load**: it exports a
    bare function (OpenCode 1.x plugin shape) and 2.0.22's loader requires
    `{ id, setup }`. Inert; removed or kept at will.
- **The built-in `openai` integration** (no plugin needed) exposes three
  ChatGPT OAuth methods. Empirically the **free tier is gated** — the token
  exchange 400s deterministically (three fresh attempts, same result) even
  though OpenAI's docs say Codex is included on Free for local clients. Plus/
  Pro works.
- **MCP servers**: all connected (playwright, chrome-devtools, context7,
  Github — the Github one takes the `Authorization` header; its OAuth path is
  a dead end, the auth server doesn't support dynamic client registration).
- **GitHub Copilot OAuth**: works (device-code method; credential created and
  active) — but v2.0.22 registers no models for the provider, so nothing
  appears in the picker yet.

---

## 12. Verified behaviors and known quirks

| Behavior | State |
| --- | --- |
| Sessions, chat, live sync, picks | Verified live |
| Sidebar drawer: slide, edge-pull, drag-close, click suppression | Verified in the browser (a `setPointerCapture` bug was found and fixed during testing) |
| Archive: confirm → metadata → Archived group → restore → delete forever | Verified end to end |
| MCP add/edit/remove + persistence to `opencode.json` | Verified |
| Remote MCP headers (GitHub) | Verified — the server accepts `config.headers`; the MCP connects |
| Providers panel OAuth flow: begin → URL/code → poll → complete, countdown, expiry | Verified |
| Playwright screenshots inline + lightbox | Verified end to end |
| Recently used models | Verified |
| **PATCH replaces metadata wholesale** | Read-merge-write required (implemented) |
| **MCP tools are location-scoped** | MCPs connect per loaded location |
| **GLM-model sessions wrap tool calls in `execute`** | This harness flattens MCP image output to text — inline screenshots need a native model's session |
| **The TUI's `/connect` runs its own OAuth** | Entirely inside the TUI process — nothing lands in the service log |

---

## 13. Running it

```
cd client
npm install
npm run dev        # --host: the phone reaches it over the LAN
```

- The dev proxy reads the service URL + password from
  `~/.local/state/opencode/service.json` at start.
- Phone access over the internet: an ngrok tunnel to the dev server (the
  allowed host is configured in `vite.config.ts`).
- `npm run build` — typecheck + production build (`tsc -b && vite build`).

---

## 14. Roadmap

- **File attachments** — `session.prompt` already accepts
  `files: [{ uri, name }]`; the composer needs a file input → upload via the
  fs API to a temp path → attach the uri.
- **Shipping** — the smallest ship: a tiny Node server that serves the built
  client and proxies `/api` to whatever OpenCode service is running (the same
  pattern as `vite.config.ts`, no dev server). A plugin that serves the UI
  from `opencode serve` itself would be the zero-config version.
- **Agent profiles** — OpenCode's custom agents (`agents.<id>` with `system`,
  `model`, `permissions`) support per-agent MCP/skill limiting
  (`<server>_*` and `skill` deny rules hide tools/skills from the agent —
  context saved) and an orchestrator whose `subagent` permission controls
  which profile-agents it may launch.
