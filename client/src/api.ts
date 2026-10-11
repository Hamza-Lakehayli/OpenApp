import { OpenCode } from "@opencode/client"
import { initialConnection, optionsFor, type ConnectionConfig } from "./connection"

/**
 * One client. With a connection (stored in localStorage or QR-paired) it
 * talks straight to the user's `opencode serve` with Basic auth; with none
 * it rides same-origin — which in dev is the Vite proxy.
 *
 * `reconnect` swaps the instance; ESM live bindings mean every
 * `client.x` call site sees the new one. Connection changes still end in a
 * full reload so the event pump and caches boot fresh.
 */
export let client = OpenCode.make(optionsFor(initialConnection))

export function reconnect(cfg: ConnectionConfig | null) {
  client = OpenCode.make(optionsFor(cfg))
}

export type {
  SessionInfo,
  ModelInfo,
  AgentInfo,
  SessionMessageInfo,
  V2Event,
  ModelRef,
} from "@opencode/client"
