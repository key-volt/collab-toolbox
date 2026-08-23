import { expect, test, type Page } from '@playwright/test'

import {
  ADMIN_PASSWORD,
  adminToken,
  captureBrowserErrors,
  createDocument,
  createWhitelistedUser,
  grantEdit,
  signIn,
  uniqueName,
} from './helpers'

interface CodeDebug {
  fileCount: () => number
  paths: () => string[]
  activeFile: () => string | undefined
  setActiveFile: (path: string) => void
  docText: (path: string) => string | null | undefined
  editorText: () => string
  lintCount: () => number
  undo: () => void
  dropConnection: () => void
}

declare global {
  interface Window {
    __codeDebug?: CodeDebug
  }
}

async function docText(page: Page, path: string): Promise<string> {
  return page.evaluate((wanted) => window.__codeDebug?.docText(wanted) ?? '', path)
}

async function typeIntoEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.type(text)
}

test('code: edits converge, undo is per user, cursors are file-scoped, lint reports', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000)
  const memberName = uniqueName('coder')
  await createWhitelistedUser(request, memberName, 'a-long-password')
  const docId = await createDocument(request, 'code', uniqueName('Project'))
  await grantEdit(request, docId, memberName)

  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()
  captureBrowserErrors(pageA, 'coder-A')
  captureBrowserErrors(pageB, 'coder-B')

  await signIn(pageA, 'admin', ADMIN_PASSWORD)
  await signIn(pageB, memberName, 'a-long-password')
  await pageA.goto(`/t/code/${docId}`)
  await pageB.goto(`/t/code/${docId}`)
  await pageA.locator('.cm-content').waitFor()
  await pageB.locator('.cm-content').waitFor()
  // The template seeded: both sides hold the hello file before anything is typed.
  await expect.poll(() => docText(pageA, 'main.py'), { timeout: 30_000 }).toContain('Hello')
  await expect.poll(() => docText(pageB, 'main.py'), { timeout: 30_000 }).toContain('Hello')

  // A types; B converges. The chain is asserted one link at a time: the editor took
  // the keystrokes, the shared document holds them, the peer sees them.
  await typeIntoEditor(pageA, '# alpha\n')
  await expect.poll(() => pageA.evaluate(() => window.__codeDebug?.editorText() ?? '')).toContain(
    '# alpha',
  )
  await expect.poll(() => docText(pageA, 'main.py')).toContain('# alpha')
  await expect.poll(() => docText(pageB, 'main.py'), { timeout: 15_000 }).toContain('# alpha')

  // B types too; both see both edits.
  await typeIntoEditor(pageB, '# beta\n')
  await expect.poll(() => docText(pageA, 'main.py'), { timeout: 15_000 }).toContain('# beta')

  // B's undo reverts only B's edit; A's line survives.
  await pageB.evaluate(() => window.__codeDebug?.undo())
  await expect.poll(() => docText(pageA, 'main.py'), { timeout: 15_000 }).not.toContain('# beta')
  expect(await docText(pageA, 'main.py')).toContain('# alpha')

  // Remote cursors render for the same open file…
  await pageA.locator('.cm-content').click()
  await expect
    .poll(() => pageB.locator('.cm-ySelectionCaret').count(), { timeout: 15_000 })
    .toBeGreaterThan(0)

  // …and disappear once B works in a different file.
  await pageB.getByRole('button', { name: 'New file' }).click()
  await pageB.getByLabel(/Path, folders included/).fill('notes.md')
  await pageB.getByRole('button', { name: 'Create' }).click()
  await expect.poll(() => pageB.locator('.cm-ySelectionCaret').count(), { timeout: 15_000 }).toBe(0)
  // The new file reached A's tree as well.
  await expect
    .poll(() => pageA.evaluate(() => window.__codeDebug?.paths() ?? []), { timeout: 15_000 })
    .toContain('notes.md')

  // Live lint: an unused import draws a diagnostic on the drawing client.
  await pageB.evaluate(() => window.__codeDebug?.setActiveFile('main.py'))
  await pageA.evaluate(() => window.__codeDebug?.setActiveFile('main.py'))
  await typeIntoEditor(pageA, 'import os\n')
  await expect
    .poll(() => pageA.evaluate(() => window.__codeDebug?.lintCount() ?? -1), { timeout: 60_000 })
    .toBeGreaterThan(0)

  // The elected client persists: the server-side file catches up with the document.
  const token = await adminToken(request)
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/documents/${docId}/files/main.py`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        return response.ok() ? await response.text() : ''
      },
      { timeout: 60_000 },
    )
    .toContain('# alpha')

  // Reconnect: kill B's socket, let A edit meanwhile, and B converges after recovery.
  await pageB.evaluate(() => window.__codeDebug?.dropConnection())
  await typeIntoEditor(pageA, '# gamma\n')
  await expect.poll(() => docText(pageB, 'main.py'), { timeout: 30_000 }).toContain('# gamma')

  await contextA.close()
  await contextB.close()
})
