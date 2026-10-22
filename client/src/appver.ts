/*
   New building ships when it ships: phones reopen this app with a cached
   old bundle. The launcher exposes the current build's hash; when the
   page (re)gains visibility with a stale one, reload so "close it, open
   it" always runs the newest build. Reloads only while hidden or on
   becoming visible — never mid-typing.
*/
let known: string | null = null

async function check() {
  try {
    const res = await fetch("/_agentlink/build?ts=" + Date.now(), {
      cache: "no-store",
    })
    const { hash } = (await res.json()) as { hash?: string }
    if (typeof hash !== "string" || !hash) return
    if (known == null) {
      known = hash
      return
    }
    if (hash !== known) {
      known = hash
      if (document.hidden) location.reload()
      else location.reload() // on visibility change / periodic: get fresh
    }
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
