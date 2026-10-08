import type { ModelInfo, ModelRef } from "@opencode/client"

/**
 * Recently used models — localStorage-backed, so the picker surfaces the
 * models the user actually reaches for without scanning the full list.
 * Keyed by `providerID/id`, capped to the last few entries.
 */

const KEY = "opencode-recent-models"
const CAP = 8
const SHOW = 5

type Recents = Record<string, number> // providerID/id -> last used (epoch ms)

export const recentKey = (m: ModelRef): string => `${m.providerID}/${m.id}`

function read(): Recents {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "") as Recents
  } catch {
    return {}
  }
}

function write(recents: Recents) {
  const entries = Object.entries(recents)
    .sort((a, b) => b[1] - a[1])
    .slice(0, CAP)
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    /* storage full or unavailable — recents are best-effort */
  }
}

/** Record a model as used now. */
export function touchRecent(model: ModelRef | undefined) {
  if (!model?.providerID || !model?.id) return
  const recents = read()
  recents[recentKey(model)] = Date.now()
  write(recents)
}

/** The available models the user used recently, most recent first. */
export function recentModels(models: ModelInfo[]): ModelInfo[] {
  const recents = read()
  return models
    .filter((m) => recents[recentKey(m)] != null)
    .sort(
      (a, b) => recents[recentKey(b)] - recents[recentKey(a)],
    )
    .slice(0, SHOW)
}
