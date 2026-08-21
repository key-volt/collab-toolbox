import { expect, test } from '@playwright/test'

test('the health endpoint reports the service as ok', async ({ request }) => {
  const response = await request.get('/api/health')

  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ status: 'ok' })
})

test('the application shell loads and reaches the backend', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'collab-toolbox' })).toBeVisible()
  await expect(page.getByTestId('service-status')).toHaveText('ok')
})

test('unknown paths fall back to the application shell', async ({ page }) => {
  await page.goto('/t/paint/no-such-document')

  await expect(page.getByRole('heading', { name: 'collab-toolbox' })).toBeVisible()
})

test('responses refuse to be framed by another origin', async ({ request }) => {
  const response = await request.get('/')

  const csp = response.headers()['content-security-policy']
  expect(csp).toBeDefined()
  expect(csp).toContain("frame-ancestors 'self'")
})
