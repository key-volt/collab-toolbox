import { expect, type APIRequestContext, type Page } from '@playwright/test'

export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? ''

// One admin login per run, not per helper call: the service rate-limits logins per
// username, and a retrying suite would otherwise burn through that budget and then
// fail on the limiter instead of the thing under test.
let cachedAdminToken: string | null = null

export async function adminToken(request: APIRequestContext): Promise<string> {
  if (cachedAdminToken !== null) return cachedAdminToken
  const response = await request.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  })
  if (!response.ok()) {
    const body = await response.text()
    throw new Error(`admin login failed with status ${String(response.status())}: ${body}`)
  }
  const body = (await response.json()) as { access_token: string }
  cachedAdminToken = body.access_token
  return cachedAdminToken
}

export async function createWhitelistedUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const token = await adminToken(request)
  const headers = { Authorization: `Bearer ${token}` }
  const created = await request.post('/api/admin/users', {
    headers,
    data: { username, password },
  })
  expect(created.status()).toBe(201)
  const row = (await created.json()) as { id: string }
  const patched = await request.patch(`/api/admin/users/${row.id}`, {
    headers,
    data: { is_whitelisted: true },
  })
  expect(patched.ok()).toBe(true)
}

export async function createDocument(
  request: APIRequestContext,
  tool: string,
  title: string,
): Promise<string> {
  const token = await adminToken(request)
  const created = await request.post('/api/documents', {
    headers: { Authorization: `Bearer ${token}` },
    data: { tool, title },
  })
  expect(created.status()).toBe(201)
  const body = (await created.json()) as { id: string }
  return body.id
}

export async function userId(request: APIRequestContext, username: string): Promise<string> {
  const token = await adminToken(request)
  const response = await request.get('/api/admin/users', {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(response.ok()).toBe(true)
  const users = (await response.json()) as { id: string; username: string }[]
  const row = users.find((candidate) => candidate.username === username)
  if (row === undefined) throw new Error(`no such user: ${username}`)
  return row.id
}

// Documents start accessible to no one but their owner and admins; suites that put a
// member into an admin-created document must grant that member access first.
export async function setDocumentAccess(
  request: APIRequestContext,
  docId: string,
  entries: { user_id: string; level: 'read' | 'edit' }[],
): Promise<void> {
  const token = await adminToken(request)
  const response = await request.put(`/api/documents/${docId}/access`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { entries },
  })
  expect(response.ok()).toBe(true)
}

export async function grantEdit(
  request: APIRequestContext,
  docId: string,
  username: string,
): Promise<void> {
  const id = await userId(request, username)
  await setDocumentAccess(request, docId, [{ user_id: id, level: 'edit' }])
}

export async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 10_000).toString(36)}`
}

// Any script error in either browser lands in the test output, so a failure report
// carries its own diagnosis instead of a bare timeout. Console errors carry their
// source URL: a network failure's message text is only "Failed to load resource…",
// and without the URL nobody can tell an expected pre-login 401 probe from a real
// missing asset.
export function captureBrowserErrors(page: Page, label: string): void {
  page.on('pageerror', (error) => {
    console.log(`[${label} pageerror] ${error.message}`)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const url = message.location().url
      console.log(`[${label} console.error] ${message.text()}${url === '' ? '' : ` (${url})`}`)
    }
  })
}
