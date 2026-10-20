/*
   Phone → PC file upload. The launcher (same origin) saves the bytes on
   the PC under client/uploads/ and answers with the absolute path, which
   then rides into the prompt like any workspace file reference. The
   OpenCode API attaches files by path only — there is no upload endpoint
   on the server itself, so the launcher provides one.
*/
export async function uploadFile(
  file: File,
): Promise<{ uri: string; name: string }> {
  const name = encodeURIComponent(file.name || "upload.bin")
  const res = await fetch(`/_agentlink/upload?name=${name}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  })
  const data = (await res.json().catch(() => ({}))) as {
    path?: string
    error?: string
  }
  if (!res.ok || !data.path) {
    throw new Error(data.error || `upload failed (HTTP ${res.status})`)
  }
  return { uri: data.path, name: data.path.split(/[\\/]/).pop() || file.name }
}
