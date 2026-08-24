// Client-driven persistence: the elected client serializes the live document and posts
// it. The server writes bytes and mirrors page lists; it never interprets content.

import { getAccessToken } from './api'

// Browsers cap keepalive request bodies (~64 kB); larger final pushes go out as a
// normal request and simply may not finish if the page is torn down first. The loss is
// bounded by the autosave interval either way.
const KEEPALIVE_LIMIT = 60_000

export interface ToolsInfo {
  tools: { slug: string; title: string }[]
  autosave_seconds: number
}

// Resolves to null when the server accepted the push, or to a short reason when it
// refused it — the label must never claim "saved" for a refused push. Only transport
// failures reject.
export async function pushSnapshot(
  tool: string,
  docId: string,
  body: string,
  contentType: string,
  final = false,
): Promise<string | null> {
  const token = getAccessToken()
  if (token === null) return 'no session'
  const response = await fetch(`/api/tools/${tool}/${docId}/snapshot`, {
    method: 'POST',
    keepalive: final && body.length < KEEPALIVE_LIMIT,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
    },
    body,
  })
  if (response.ok) return null
  let detail = ''
  try {
    const parsed: unknown = await response.json()
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'detail' in parsed &&
      typeof parsed.detail === 'string'
    ) {
      detail = parsed.detail
    }
  } catch {
    // no JSON body — the status alone will have to name it
  }
  return detail === '' ? `HTTP ${String(response.status)}` : detail
}
