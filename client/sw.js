/*
   agentlink push service worker: Web Push → notification.
   adapterlink (the launcher on the PC) already decided this push is
   worth showing (the session really is waiting on the user); the worker
   just stays quiet if the app is open and focused on this device.
*/
self.addEventListener("push", (e) => {
  let d = {}
  try { d = e.data.json() } catch {}
  e.waitUntil(
    (async () => {
      const cs = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      // the user is already looking at the app on this device: no buzz
      if (cs.some((c) => c.visibilityState === "visible")) return
      await self.registration.showNotification(d.title || "OpenCode", {
        body: d.body || "",
        tag: d.tag || "opencode", // same-topic pushes collapse
        renotify: true,
        data: { url: d.url || "/" },
      })
    })(),
  )
})

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
