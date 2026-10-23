/*
   Interactive questions: the `question` tool pauses a session by creating a
   form server-side (metadata.kind === "question"); clients render it and
   reply. The SDK predates the form API, so these ride raw fetch with the
   same connection rules as api-post.

   Single-choice fields are type "string", multi are "multiselect"; when a
   field allows free-form input (custom) the typed text is sent as the value.
*/
import { optionsFor, loadConnection } from "./connection"

export type FormOption = { value: string; label: string; description?: string }

export type FormField = {
  key: string
  title: string
  description?: string
  type: "string" | "multiselect" | "boolean" | "number" | "integer" | "external"
  options?: FormOption[]
  custom?: boolean
}

export type QuestionForm = {
  id: string
  sessionID: string
  title: string
  metadata?: {
    kind?: string
    tool?: { messageID: string; id: string }
  }
  fields: FormField[]
}

function req(path: string, init?: RequestInit): Promise<Response> {
  const o = optionsFor(loadConnection())
  return fetch(o.baseUrl + path, {
    ...init,
    headers: { "content-type": "application/json", ...(o.headers ?? {}), ...init?.headers },
  })
}

export async function listForms(sessionID: string): Promise<QuestionForm[]> {
  try {
    const res = await req(`/api/session/${sessionID}/form`)
    if (!res.ok) return []
    const json = (await res.json()) as { data?: QuestionForm[] }
    return json.data ?? []
  } catch {
    return []
  }
}

/** answer = { fieldKey: value | values } — 204 on success. */
export async function replyForm(
  sessionID: string,
  formID: string,
  answer: Record<string, string | string[]>,
): Promise<boolean> {
  try {
    const res = await req(`/api/session/${sessionID}/form/${formID}/reply`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Dismissing cancels the question: the tool returns and the agent moves on. */
export async function cancelForm(sessionID: string, formID: string): Promise<void> {
  try {
    await req(`/api/session/${sessionID}/form/${formID}`, { method: "DELETE" })
  } catch {
    /* already gone */
  }
}
