import { expect, test, type Page } from '@playwright/test'

import {
  ADMIN_PASSWORD,
  captureBrowserErrors,
  createDocument,
  createWhitelistedUser,
  grantEdit,
  signIn,
  uniqueName,
} from './helpers'

interface PaintDebug {
  elementCount: () => number
  sceneCount: () => number
  sceneCountAll: () => number
  everSceneCount: () => number
  activeTool: () => string
  collaboratorCount: () => number
  setTool: (tool: string) => void
  undo: () => void
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

async function sceneCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__paintDebug?.sceneCount() ?? -1)
}

async function everSceneCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__paintDebug?.everSceneCount() ?? -1)
}

// Excalidraw floats its own UI over the canvas: with a drawing tool active, a 200px-wide
// shape-properties island docks over the top-left of the canvas, the toolbar hangs over
// the top-center, and the zoom/undo island sits bottom-left. A pointer that lands on any
// of them starts no shape and raises no error. Every drawing coordinate in this file
// therefore stays inside the clear region (x ≥ 260, y ≥ 90, extents away from the
// bottom edge), and the drag hit-tests its exact starting point before pressing the
// button — so a future layout change fails by naming the covering element instead of
// timing out on a zero count.
async function drawRectangle(page: Page, x: number, y: number): Promise<void> {
  const canvas = page.locator('.excalidraw canvas').first()
  await canvas.waitFor()
  // Tool selection goes through the editor's own API — a keyboard shortcut depends on
  // where focus happens to be, which a test must not. The change flows through React
  // state, so the drag waits until the editor actually reports the tool as active.
  await page.evaluate(() => window.__paintDebug?.setTool('rectangle'))
  await expect
    .poll(() => page.evaluate(() => window.__paintDebug?.activeTool() ?? 'no debug handle'))
    .toBe('rectangle')
  const box = await canvas.boundingBox()
  if (box === null) throw new Error('canvas has no size')
  const covering = await page.evaluate(
    ([pointX, pointY]) => {
      const hit = document.elementFromPoint(pointX, pointY)
      if (hit === null) return 'nothing'
      if (hit instanceof HTMLCanvasElement) return 'canvas'
      return `<${hit.tagName.toLowerCase()} class="${hit.getAttribute('class') ?? ''}">`
    },
    [box.x + x, box.y + y],
  )
  if (covering !== 'canvas') {
    throw new Error(
      `nothing can be drawn at (${String(x)}, ${String(y)}): the point is covered by ` +
        `${covering} — move the drag clear of the editor's floating UI`,
    )
  }
  await page.mouse.move(box.x + x, box.y + y)
  await page.mouse.down()
  await page.waitForTimeout(50)
  await page.mouse.move(box.x + x + 120, box.y + y + 80, { steps: 10 })
  await page.waitForTimeout(50)
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
  await grantEdit(request, docId, memberName)

  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  captureBrowserErrors(pageA, 'painter-A')
  captureBrowserErrors(pageB, 'painter-B')

  await signIn(pageA, 'admin', ADMIN_PASSWORD)
  await signIn(pageB, memberName, 'a-long-password')
  await pageA.goto(`/t/paint/${docId}`)
  await pageB.goto(`/t/paint/${docId}`)
  await pageA.locator('.excalidraw canvas').first().waitFor()
  await pageB.locator('.excalidraw canvas').first().waitFor()
  await expect.poll(() => elementCount(pageA), { timeout: 30_000 }).toBe(0)
  await expect.poll(() => elementCount(pageB), { timeout: 30_000 }).toBe(0)

  // A draws. The assertions walk the chain one link at a time — tool active and canvas
  // hit (inside the draw), shape ever registered by the canvas, shape alive in the
  // scene, shape in the shared document, shape on the other client — so a failure
  // names its exact link.
  await drawRectangle(pageA, 300, 160)
  await expect.poll(() => everSceneCount(pageA)).toBeGreaterThan(0)
  await expect.poll(() => sceneCount(pageA)).toBeGreaterThan(0)
  await expect.poll(() => elementCount(pageA)).toBe(1)
  await expect.poll(() => elementCount(pageB)).toBe(1)

  // B edits too; both see two elements.
  await drawRectangle(pageB, 480, 280)
  await expect.poll(() => elementCount(pageA)).toBe(2)
  await expect.poll(() => elementCount(pageB)).toBe(2)

  // B's undo reverts only B's edit…
  await pageB.evaluate(() => window.__paintDebug?.undo())
  await expect.poll(() => elementCount(pageA)).toBe(1)
  await expect.poll(() => elementCount(pageB)).toBe(1)

  // …and A's undo reverts A's own, proving neither touched the other's work.
  await pageA.evaluate(() => window.__paintDebug?.undo())
  await expect.poll(() => elementCount(pageA)).toBe(0)
  await expect.poll(() => elementCount(pageB)).toBe(0)

  // Cursors: B sees A while both look at the same page. The pointer wander stays over
  // the canvas clear region — pointer positions only reach awareness while the pointer
  // is actually on the canvas.
  await drawRectangle(pageA, 300, 320)
  const boxA = await pageA.locator('.excalidraw canvas').first().boundingBox()
  if (boxA === null) throw new Error('canvas has no size')
  await pageA.mouse.move(boxA.x + 500, boxA.y + 200)
  await pageA.mouse.move(boxA.x + 560, boxA.y + 240)
  await expect
    .poll(() => pageB.evaluate(() => window.__paintDebug?.collaboratorCount() ?? -1), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0)

  // …and stops seeing A after switching to a page of their own.
  await pageB.getByRole('button', { name: 'Add page' }).click()
  await expect
    .poll(() => pageB.evaluate(() => window.__paintDebug?.collaboratorCount() ?? -1), {
      timeout: 15_000,
    })
    .toBe(0)
  await pageB.getByRole('button', { name: 'Page 1', exact: true }).click()

  // Reconnect: kill B's socket, let A edit meanwhile, and B converges after recovery.
  await pageB.evaluate(() => window.__paintDebug?.dropConnection())
  await drawRectangle(pageA, 520, 160)
  await expect.poll(() => elementCount(pageA)).toBe(2)
  await expect.poll(() => elementCount(pageB), { timeout: 30_000 }).toBe(2)

  await contextA.close()
  await contextB.close()
})
