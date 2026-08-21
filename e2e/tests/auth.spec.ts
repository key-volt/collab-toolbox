import { expect, test } from '@playwright/test'

import { ADMIN_PASSWORD, adminToken, createWhitelistedUser, signIn, uniqueName } from './helpers'

test('the admin signs in and reaches the document grid', async ({ page }) => {
  await signIn(page, 'admin', ADMIN_PASSWORD)

  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Users/ })).toBeVisible()
})

test('a wrong password is refused on the login screen', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('definitely-wrong')
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByText('wrong username or password')).toBeVisible()
})

test('a non-whitelisted account sees only the pending screen', async ({ page, request }) => {
  const username = uniqueName('pending')
  const token = await adminToken(request)
  const created = await request.post('/api/admin/users', {
    headers: { Authorization: `Bearer ${token}` },
    data: { username, password: 'a-long-password' },
  })
  expect(created.status()).toBe(201)

  await signIn(page, username, 'a-long-password')

  await expect(page.getByText('Your account is waiting for approval.')).toBeVisible()
  await page.goto('/')
  await expect(page.getByText('Your account is waiting for approval.')).toBeVisible()
})

test('a whitelisted account reaches documents but not admin screens', async ({
  page,
  request,
}) => {
  const username = uniqueName('member')
  await createWhitelistedUser(request, username, 'a-long-password')

  await signIn(page, username, 'a-long-password')

  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible()
  await page.goto('/admin/users')
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible()
})
