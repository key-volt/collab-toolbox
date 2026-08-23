import { expect, test, type Frame, type Page } from '@playwright/test'

import {
  ADMIN_PASSWORD,
  captureBrowserErrors,
  createDocument,
  createWhitelistedUser,
  grantEdit,
  signIn,
  uniqueName,
} from './helpers'

interface EditorDebug {
  addCell: (label: string, x: number, y: number) => void
  cellCount: () => number
  undo: () => void
}

declare global {
  interface Window {
    __editorDebug?: EditorDebug
    __editorBootStage?: string
  }
}

async function editorFrame(page: Page): Promise<Frame> {
  const element = await page.waitForSelector('iframe[title="Diagram editor"]')
  const frame = await element.contentFrame()
  if (frame === null) throw new Error('the editor frame did not attach')
  try {
    await frame.waitForFunction(() => window.__editorDebug !== undefined, undefined, {
      timeout: 120_000,
    })
  } catch {
    // The child publishes its boot progress; a stall names the exact step.
    const stage = await frame
      .evaluate(() => window.__editorBootStage ?? 'no boot stage was ever set')
      .catch(() => 'the frame is gone')
    throw new Error(`the editor never became ready — boot stage: ${stage}`)
  }
  return frame
}

async function cellCount(frame: Frame): Promise<number> {
  return frame.evaluate(() => window.__editorDebug?.cellCount() ?? -1)
}

test('drawio: edits converge across clients and undo is per user', async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000)
  const memberName = uniqueName('diagrammer')
  await createWhitelistedUser(request, memberName, 'a-long-password')
  const docId = await createDocument(request, 'drawio', uniqueName('Plan'))
  await grantEdit(request, docId, memberName)

  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  captureBrowserErrors(pageA, 'diagrammer-A')
  captureBrowserErrors(pageB, 'diagrammer-B')

  await signIn(pageA, 'admin', ADMIN_PASSWORD)
  await signIn(pageB, memberName, 'a-long-password')
  await pageA.goto(`/t/drawio/${docId}`)
  await pageB.goto(`/t/drawio/${docId}`)

  const frameA = await editorFrame(pageA)
  const frameB = await editorFrame(pageB)

  // The deterministic template gives every client the same two structural cells.
  await expect.poll(() => cellCount(frameA), { timeout: 30_000 }).toBe(2)
  await expect.poll(() => cellCount(frameB), { timeout: 30_000 }).toBe(2)

  // A adds a shape and B converges.
  await frameA.evaluate(() => window.__editorDebug?.addCell('from-a', 80, 80))
  await expect.poll(() => cellCount(frameA), { timeout: 30_000 }).toBe(3)
  await expect.poll(() => cellCount(frameB), { timeout: 30_000 }).toBe(3)

  // B adds one too; both see four cells.
  await frameB.evaluate(() => window.__editorDebug?.addCell('from-b', 320, 200))
  await expect.poll(() => cellCount(frameA), { timeout: 30_000 }).toBe(4)
  await expect.poll(() => cellCount(frameB), { timeout: 30_000 }).toBe(4)

  // B's undo removes only B's shape.
  await frameB.evaluate(() => window.__editorDebug?.undo())
  await expect.poll(() => cellCount(frameA), { timeout: 30_000 }).toBe(3)
  await expect.poll(() => cellCount(frameB), { timeout: 30_000 }).toBe(3)

  // A's undo removes A's own; the template cells remain.
  await frameA.evaluate(() => window.__editorDebug?.undo())
  await expect.poll(() => cellCount(frameA), { timeout: 30_000 }).toBe(2)
  await expect.poll(() => cellCount(frameB), { timeout: 30_000 }).toBe(2)

  await contextA.close()
  await contextB.close()
})
