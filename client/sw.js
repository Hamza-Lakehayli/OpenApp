/*
   agentlink push service worker: Web Push → notification.
   agentlink (the launcher on the PC) already decided this push is worth
   sending; the worker only stays quiet when the user is actively ON the
   session the push is about — a blanket "app open" would hide nudges
   while they read a different session. The decision needs app knowledge,
   so the worker asks the page over a message channel and waits briefly.
*/
const CHECK_TIMEOUT = 350
const SHELL = "shell-v1"

/*
   Shell cache: reopen-the-app should not wait for a tunnel round trip.
   Serve the last known app shell instantly, revalidate from the network
   in the background; the app's build-hash check handles "was that stale?".
*/
self.addEventListener("fetch", (e) => {
  const req = e.request
  if (req.method !== "GET") return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return
  if (url.pathname === "/sw.js" || url.pathname.startsWith("/_agentlink/")) return
  const cacheable =
    req.mode === "navigate" ||
    /\.(js|css|html|woff2?|png|jpe?g|svg|ico|webmanifest)$/.test(url.pathname)
  if (!cacheable) return
  e.respondWith(
    (async () => {
      const cache = await caches.open(SHELL)
      // normalized string key: navigate Requests don't round-trip as keys
      const hit = await cache.match(url.href, { ignoreVary: true })
      // network refresher: fills/updates the cache, survives offline
      const fresh = fetch(req)
        .then((res) => {
          if (res && res.ok) return cache.put(url.href, res.clone()).then(() => res)
          return res
        })
        .catch(() => hit)
      return hit || fresh
    })(),
  )
})

self.addEventListener("push", (e) => {
  let d = {}
  try { d = e.data.json() } catch {}
  e.waitUntil(
    (async () => {
      const url = d.url || "/"
      const about = (d.tag || "").startsWith("ask:")
        ? "ask"
        : (d.tag || "").split(":")[1] // turn:<sid>
      const visible = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      }).then((cs) =>
        cs.map((c) => ({ client: c, state: c.visibilityState })),
      )
      const looking = visible.filter((v) => v.state === "visible")
      if (looking.length && about) {
        // someone has the app on screen — is it THIS session?
        for (const v of looking) {
          if (await askSession(v.client) === about) return // already watching it
        }
      } else if (looking.length && !about) {
        return // untargeted test push and the app is open: don't buzz
      }
      await self.registration.showNotification(d.title || "OpenCode", {
        body: d.body || "",
        tag: d.tag || "opencode", // same-topic pushes collapse
        renotify: true,
        data: { url, sid: about },
      })
    })(),
  )
})

// one round trip: the app keeps a listener armed for this question
function askSession(client) {
  return new Promise((resolve) => {
    const ch = new MessageChannel()
    const timer = setTimeout(() => resolve(null), CHECK_TIMEOUT)
    ch.port1.onmessage = (e) => {
      clearTimeout(timer)
      resolve(e.data?.sessionID ?? null)
    }
    try {
      client.postMessage({ type: "which-session?" }, [ch.port2])
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  const target = e.notification.data?.url || "/"
  e.waitUntil(
    (async () => {
      const cs = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      const base = (target.split("#")[0].split("?")[0] || "").replace(/\/$/, "")
      for (const c of cs) {
        if (c.url.startsWith(base)) {
          if ("navigate" in c && target.includes("#")) {
            await c.focus()
            c.postMessage(target) // the app listens and jumps to the session
            return
          }
          return c.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target)
    })(),
  )
})
