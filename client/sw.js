/*
   agentlink push service worker: Web Push → notification.
   agentlink (the launcher on the PC) already decided this push is worth
   sending; the worker only stays quiet when the user is actively ON the
   session the push is about — a blanket "app open" would hide nudges
   while they read a different session. The decision needs app knowledge,
   so the worker asks the page over a message channel and waits briefly.
*/
const CHECK_TIMEOUT = 350

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
