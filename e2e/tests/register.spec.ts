import { expect, test } from '@playwright/test'

import { adminToken, captureBrowserErrors, signIn, uniqueName } from './helpers'

// One registration per run on purpose: the endpoint rate-limits registrations per
// address, and a retried suite must stay inside that budget.
test('a visitor registers through the captcha, waits, and enters once approved', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  captureBrowserErrors(page, 'registrant')
  const username = uniqueName('joiner')

  await page.goto('/login')
  await page.getByRole('link', { name: 'Register' }).click()
  await page.waitForURL((url) => url.pathname === '/register')

  await page.getByLabel(/Username/).fill(username)
  await page.getByLabel(/Password/).fill('a-long-password')

  // The proof-of-work widget: arm it, let it solve, and the submit button unlocks.
  // The checkbox input sits under a decorative checkmark svg that intercepts clicks,
  // so the click goes to its associated label — the same element a person clicks.
  const widget = page.locator('altcha-widget')
  await widget.waitFor()
  const checkbox = widget.locator('input[type="checkbox"]')
  await checkbox.waitFor()
  const checkboxId = await checkbox.getAttribute('id')
  await widget.locator(`label[for="${checkboxId ?? ''}"]`).click()
  const submit = page.getByRole('button', { name: /Register|Waiting/ })
  await expect(submit).toBeEnabled({ timeout: 60_000 })
  await submit.click()

  await expect(page.getByText('Your account is waiting for approval.')).toBeVisible()

  // The admin sees the pending account and approves it.
  const token = await adminToken(request)
  const listed = await request.get('/api/admin/users', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const rows = (await listed.json()) as { id: string; username: string; is_whitelisted: boolean }[]
  const row = rows.find((entry) => entry.username === username)
  expect(row).toBeDefined()
  expect(row?.is_whitelisted).toBe(false)
  const patched = await request.patch(`/api/admin/users/${row?.id ?? ''}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { is_whitelisted: true },
  })
  expect(patched.ok()).toBe(true)

  // Approval takes effect on the next session use: sign in again and reach documents.
  await signIn(page, username, 'a-long-password')
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible()
})
