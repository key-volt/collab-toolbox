import { expect, type APIRequestContext, type Page } from '@playwright/test'

export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? ''

export async function adminToken(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/auth/login', {
    data: { username: 'admin', password: ADMIN_PASSWORD },
  })
  expect(response.ok(), 'admin login must succeed — is E2E_ADMIN_PASSWORD set?').toBe(true)
  const body = (await response.json()) as { access_token: string }
  return body.access_token
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
// carries its own diagnosis instead of a bare timeout.
export function captureBrowserErrors(page: Page, label: string): void {
  page.on('pageerror', (error) => {
    console.log(`[${label} pageerror] ${error.message}`)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') {
      console.log(`[${label} console.error] ${message.text()}`)
    }
  })
}
