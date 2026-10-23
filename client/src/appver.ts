/*
   New builds ship when they ship: phones reopen this app from a cached old
   shell (service worker cache, HTTP cache). The launcher stamps every served
   page with its build hash and answers the current hash at
   /_agentlink/build — when the running page's stamp differs from the
   server's, reload. Checks run on wake (visibility) and periodically while
   backgrounded, so "close it, open it" always lands on the newest build.
*/
function runningBuild(): string | null {
  return (
    document.querySelector('meta[name="agentlink-build"]')?.getAttribute("content") ?? null
  )
}

async function check() {
  try {
    const res = await fetch("/_agentlink/build?ts=" + Date.now(), {
      cache: "no-store",
    })
    const { hash } = (await res.json()) as { hash?: string }
    if (typeof hash !== "string" || !hash) return
    const mine = runningBuild()
    // no stamp (dev server) or first boot after the mechanism shipped: adopt
    if (!mine || mine === hash) return
    location.reload()
  } catch {
    /* launcher down: nothing to compare */
  }
}

export function watchBuild() {
  void check()
  setInterval(() => {
    if (document.hidden) void check() // cheap while backgrounded
  }, 60_000)
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void check()
  })
}
