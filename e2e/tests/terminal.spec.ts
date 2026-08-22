import { expect, test, type Frame, type Page } from '@playwright/test'

import { ADMIN_PASSWORD, adminToken, captureBrowserErrors, createDocument, signIn, uniqueName } from './helpers'

interface TermDebug {
  stage: () => string
  state: () => string
  graphicsCount: () => number
  push: (line: string) => void
  text: () => string
}

declare global {
  interface Window {
    __termDebug?: TermDebug
  }
}

function findSandboxFrame(page: Page): Frame | undefined {
  return page.frames().find((candidate) => candidate.url().includes('/sandbox/'))
}

// Used only after the stage poll proved the frame is up.
function sandboxFrame(page: Page): Frame {
  const frame = findSandboxFrame(page)
  if (frame === undefined) throw new Error('the sandbox frame is not attached')
  return frame
}

async function termStage(page: Page): Promise<string> {
  const frame = findSandboxFrame(page)
  if (frame === undefined) return 'frame not attached yet'
  return frame.evaluate(() => window.__termDebug?.stage() ?? 'no debug handle')
}

async function termText(page: Page): Promise<string> {
  return sandboxFrame(page).evaluate(() => window.__termDebug?.text() ?? '')
}

async function pushLine(page: Page, line: string): Promise<void> {
  await sandboxFrame(page).evaluate((entered) => window.__termDebug?.push(entered), line)
}

test('terminal: boots isolated, runs Python and plots, blocks tkinter, and stops', async ({
  page,
  request,
}) => {
  // The first boot downloads the interpreter from the container; give it room.
  test.setTimeout(420_000)
  captureBrowserErrors(page, 'terminal')
  const docId = await createDocument(request, 'code', uniqueName('Sandbox'))

  // A two-file project, pushed straight through the snapshot API so Run can prove
  // that sibling imports work against the copied tree.
  const token = await adminToken(request)
  const pushed = await request.post(`/api/tools/code/${docId}/snapshot`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: {
      files: [
        { path: 'main.py', text: 'import util\nprint("sum is", util.add(2, 3))\n' },
        { path: 'util.py', text: 'def add(a, b):\n    return a + b\n' },
      ],
    },
  })
  expect(pushed.ok()).toBe(true)

  await signIn(page, 'admin', ADMIN_PASSWORD)
  await page.goto(`/t/code/${docId}`)
  await page.locator('.cm-content').waitFor()
  await page.getByRole('button', { name: 'Terminal' }).click()
  await page.locator('[data-testid="sandbox-panel"]').waitFor()

  // Boot is staged so a hang names its step instead of timing out namelessly.
  await expect.poll(() => termStage(page), { timeout: 240_000 }).toBe('ready')

  // The isolation contract, executed: no cookies in the frame, the API unreachable
  // from it, the parent page's DOM sealed off. This is the safety bar as a test.
  const isolation = await sandboxFrame(page).evaluate(async () => {
    const report = { cookie: 'unknown', api: 'unknown', parentDom: 'unknown' }
    try {
      report.cookie = document.cookie === '' ? 'empty' : 'present'
    } catch {
      report.cookie = 'blocked'
    }
    try {
      await fetch(new URL('/api/health', window.location.href).href)
      report.api = 'reachable'
    } catch {
      report.api = 'blocked'
    }
    try {
      void window.parent.document
      report.parentDom = 'reachable'
    } catch {
      report.parentDom = 'blocked'
    }
    return report
  })
  expect(isolation.cookie).not.toBe('present')
  expect(isolation.api).toBe('blocked')
  expect(isolation.parentDom).toBe('blocked')

  // The REPL answers.
  await pushLine(page, 'print(21 * 2)')
  await expect.poll(() => termText(page), { timeout: 60_000 }).toContain('42')

  // Run executes the open file against the project tree, sibling import included.
  await expect(page.getByRole('button', { name: /Run main\.py/ })).toBeEnabled()
  await page.getByRole('button', { name: /Run main\.py/ }).click()
  await expect.poll(() => termText(page), { timeout: 120_000 }).toContain('sum is 5')

  // A plot lands in the graphics pane. The first matplotlib import downloads the
  // bundled wheels from the container, so this link gets its own generous timeout.
  await pushLine(page, 'import matplotlib.pyplot as plt')
  await expect.poll(() => termStage(page), { timeout: 180_000 }).toBe('ready')
  await pushLine(page, 'plt.plot([1, 2, 3], [2, 4, 9])')
  await expect
    .poll(
      () => sandboxFrame(page).evaluate(() => window.__termDebug?.graphicsCount() ?? -1),
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0)

  // tkinter is impossible in a browser; the message says so and names the substitutes.
  await pushLine(page, 'import tkinter')
  await expect.poll(() => termText(page), { timeout: 60_000 }).toContain('cannot run in a browser')

  // Stop breaks an infinite loop and the prompt comes back.
  await pushLine(page, 'while True: pass')
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect.poll(() => termStage(page), { timeout: 240_000 }).toBe('ready')
  await pushLine(page, 'print("alive")')
  await expect.poll(() => termText(page), { timeout: 60_000 }).toContain('alive')
})
