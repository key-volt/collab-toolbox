// API client. The access token lives here, in memory only — never in storage an XSS
// could read. A page reload silently re-obtains one from the refresh cookie, and any
// request that meets a 401 tries that refresh exactly once before giving up.

export interface SessionUser {
  id: string
  username: string
  is_admin: boolean
  is_whitelisted: boolean
}

export interface Session {
  accessToken: string
  expiresIn: number
  user: SessionUser
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

let accessToken: string | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let refreshInFlight: Promise<Session | null> | null = null
const sessionListeners = new Set<(session: Session | null) => void>()

export function getAccessToken(): string | null {
  return accessToken
}

export function onSessionChange(listener: (session: Session | null) => void): () => void {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

interface SessionPayload {
  access_token: string
  expires_in: number
  user: SessionUser
}

function adoptSession(payload: SessionPayload): Session {
  const session: Session = {
    accessToken: payload.access_token,
    expiresIn: payload.expires_in,
    user: payload.user,
  }
  accessToken = session.accessToken
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  // Renew shortly before expiry so open editors keep a valid token for reconnects.
  const renewInMs = Math.max(30, session.expiresIn - 60) * 1000
  refreshTimer = setTimeout(() => {
    void refreshSession()
  }, renewInMs)
  sessionListeners.forEach((listener) => listener(session))
  return session
}

function dropSession(): void {
  accessToken = null
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
  sessionListeners.forEach((listener) => listener(null))
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (
      typeof body === 'object' &&
      body !== null &&
      'detail' in body &&
      typeof body.detail === 'string'
    ) {
      return body.detail
    }
  } catch {
    // fall through to the generic message
  }
  return `request failed with status ${String(response.status)}`
}

export async function refreshSession(): Promise<Session | null> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch('/api/auth/refresh', { method: 'POST' })
      if (!response.ok) {
        dropSession()
        return null
      }
      return adoptSession((await response.json()) as SessionPayload)
    } catch {
      dropSession()
      return null
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

interface RequestOptions {
  method?: string
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers }
  if (accessToken !== null) {
    headers.Authorization = `Bearer ${accessToken}`
  }
  let body = options.body
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.json)
  }
  return fetch(path, { method: options.method ?? 'GET', headers, body })
}

async function request(path: string, options: RequestOptions): Promise<Response> {
  let response = await send(path, options)
  if (response.status === 401) {
    const renewed = await refreshSession()
    if (renewed !== null) {
      response = await send(path, options)
    }
  }
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response))
  }
  return response
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(path, options)
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

export async function apiText(path: string, options: RequestOptions = {}): Promise<string> {
  const response = await request(path, options)
  return response.text()
}

export async function apiBlob(path: string, options: RequestOptions = {}): Promise<Blob> {
  const response = await request(path, options)
  return response.blob()
}

export async function login(username: string, password: string): Promise<Session> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response))
  }
  return adoptSession((await response.json()) as SessionPayload)
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' })
  } finally {
    dropSession()
  }
}

export async function fetchMe(): Promise<SessionUser> {
  return api<SessionUser>('/api/auth/me')
}
