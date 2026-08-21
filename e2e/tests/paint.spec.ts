import { expect, test, type Page } from '@playwright/test'

import { ADMIN_PASSWORD, createDocument, createWhitelistedUser, signIn, uniqueName } from './helpers'

interface PaintDebug {
  elementCount: () => number
  collaboratorCount: () => number
  dropConnection: () => void
}

declare global {
  interface Window {
    __paintDebug?: PaintDebug
  }
}

async function elementCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__paintDebug?.elementCount() ?? -1)
}

async function drawRectangle(page: Page, x: number, y: number): Promise<void> {
  const canvas = page.locator('.excalidraw canvas').first()
  await canvas.waitFor()
  await page.keyboard.press('r')
  const box = await canvas.boundingBox()
  if (box === null) throw new Error('canvas has no size')
  await page.mouse.move(box.x + x, box.y + y)
  await page.mouse.down()
  await page.mouse.move(box.x + x + 120, box.y + y + 80, { steps: 5 })
  await page.mouse.up()
}

test('paint: edits converge, undo is per user, cursors are page-isolated, reconnect recovers', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000)
  const memberName = uniqueName('painter')
  await createWhitelistedUser(request, memberName, 'a-long-password')
  const docId = await createDocument(request, 'paint', uniqueName('Board'))

  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()

  await signIn(pageA, 'admin', ADMIN_PASSWORD)
  await signIn(pageB, memberName, 'a-long-password')
  await pageA.goto(`/t/paint/${docId}`)
  await pageB.goto(`/t/paint/${docId}`)
  await pageA.locator('.excalidraw canvas').first().waitFor()
  await pageB.locator('.excalidraw canvas').first().waitFor()

  // A edits and B converges.
  await drawRectangle(pageA, 150, 150)
  await expect.poll(() => elementCount(pageA)).toBe(1)
  await expect.poll(() => elementCount(pageB)).toBe(1)

  // B edits too; both see two elements.
  await drawRectangle(pageB, 340, 220)
  await expect.poll(() => elementCount(pageA)).toBe(2)
  await expect.poll(() => elementCount(pageB)).toBe(2)

  // B's undo reverts only B's edit…
  await pageB.keyboard.press('Control+z')
  await expect.poll(() => elementCount(pageA)).toBe(1)
  await expect.poll(() => elementCount(pageB)).toBe(1)

  // …and A's undo reverts A's own, proving neither touched the other's work.
  await pageA.keyboard.press('Control+z')
  await expect.poll(() => elementCount(pageA)).toBe(0)
  await expect.poll(() => elementCount(pageB)).toBe(0)

  // Cursors: B sees A while both look at the same page…
  await drawRectangle(pageA, 200, 200)
  await pageA.mouse.move(300, 300)
  await pageA.mouse.move(360, 340)
  await expect.poll(() => pageB.evaluate(() => window.__paintDebug?.collaboratorCount() ?? -1), {
    timeout: 15_000,
  }).toBeGreaterThan(0)

  // …and stops seeing A after switching to a page of their own.
  await pageB.getByRole('button', { name: 'Add page' }).click()
  await expect.poll(() => pageB.evaluate(() => window.__paintDebug?.collaboratorCount() ?? -1), {
    timeout: 15_000,
  }).toBe(0)
  await pageB.getByRole('button', { name: 'Page 1', exact: true }).click()

  // Reconnect: kill B's socket, let A edit meanwhile, and B converges after recovery.
  await pageB.evaluate(() => window.__paintDebug?.dropConnection())
  await drawRectangle(pageA, 420, 160)
  await expect.poll(() => elementCount(pageA)).toBe(2)
  await expect.poll(() => elementCount(pageB), { timeout: 30_000 }).toBe(2)

  await contextA.close()
  await contextB.close()
})
