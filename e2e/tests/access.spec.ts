import { expect, test } from '@playwright/test'

import {
  captureBrowserErrors,
  createDocument,
  createWhitelistedUser,
  setDocumentAccess,
  signIn,
  uniqueName,
  userId,
} from './helpers'

test('access: names are public, grants gate content, revocation cuts a live session', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)
  captureBrowserErrors(page, 'access')

  const username = uniqueName('viewer')
  const password = 'a-long-password'
  await createWhitelistedUser(request, username, password)
  const viewerId = await userId(request, username)
  const title = uniqueName('Shared board')
  const docId = await createDocument(request, 'paint', title)

  // Without any grant: the name is listed, the content is not reachable.
  await signIn(page, username, password)
  await expect(page.getByText(title)).toBeVisible()
  await expect(page.getByText('no access').first()).toBeVisible()
  await page.goto(`/t/paint/${docId}`)
  await expect(page.getByText('This document is not available.')).toBeVisible()

  // Read: the document opens read-only. Nobody has ever seeded this room, so the
  // reader gets the static last-save view, and no mutating control is offered.
  await setDocumentAccess(request, docId, [{ user_id: viewerId, level: 'read' }])
  await page.goto('/')
  await expect(page.getByText('read-only').first()).toBeVisible()
  await page.goto(`/t/paint/${docId}`)
  await expect(page.getByText('Static view of the last save')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add page' })).toHaveCount(0)

  // Edit: the same document becomes fully editable.
  await setDocumentAccess(request, docId, [{ user_id: viewerId, level: 'edit' }])
  await page.goto(`/t/paint/${docId}`)
  await expect(page.getByRole('button', { name: 'Add page' })).toBeVisible()
  await expect(page.getByText('Static view of the last save')).toHaveCount(0)

  // Revocation reaches a LIVE session: no reload, the open editor is cut off.
  await setDocumentAccess(request, docId, [])
  await expect(page.getByText('This document is not available.')).toBeVisible({
    timeout: 30_000,
  })

  // The name stays listed even now.
  await page.goto('/')
  await expect(page.getByText(title)).toBeVisible()
})
