// POST helper for routes the SDK does not cover (permission replies).
import { optionsFor, loadConnection } from "./connection"

export async function apiPost(path: string, body?: unknown): Promise<Response> {
  const o = optionsFor(loadConnection())
  return fetch(o.baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(o.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
