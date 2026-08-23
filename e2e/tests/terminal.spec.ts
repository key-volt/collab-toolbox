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

// The initial selection is alphabetical over the tree, so an assertion about the
// Run button must pick its file explicitly, never inherit whatever sorts first.
async function setActiveFile(page: Page, path: string): Promise<void> {
  await page.evaluate((wanted) => {
    const withDebug = window as unknown as {
      __codeDebug?: { setActiveFile: (target: string) => void }
    }
    withDebug.__codeDebug?.setActiveFile(wanted)
  }, path)
}

test('terminal: boots isolated, runs Python and plots, drives tkinter, and stops', async ({
  page,
  request,
}) => {
  // The first boot downloads the interpreter from the container; give it room.
  test.setTimeout(420_000)
  captureBrowserErrors(page, 'terminal')
  const docId = await createDocument(request, 'code', uniqueName('Sandbox'))

  // A project pushed straight through the snapshot API: Run on main.py proves
  // sibling imports against the copied tree, and gui.py proves the tkinter
  // emulation end to end.
  const token = await adminToken(request)
  const pushed = await request.post(`/api/tools/code/${docId}/snapshot`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: {
      files: [
        { path: 'main.py', text: 'import util\nprint("sum is", util.add(2, 3))\n' },
        { path: 'util.py', text: 'def add(a, b):\n    return a + b\n' },
        {
          path: 'gui.py',
          text:
            'import tkinter as tk\n\nroot = tk.Tk()\nroot.title("Counter")\n' +
            'value = tk.IntVar()\ntk.Label(root, textvariable=value).pack()\n' +
            'tk.Button(root, text="inc", command=lambda: value.set(value.get() + 1)).pack()\n' +
            'root.mainloop()\nprint("gui ready")\n',
        },
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

  // Run executes the chosen file against the project tree, sibling import included.
  await setActiveFile(page, 'main.py')
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

  // tkinter runs as the bundled pure-Python emulation: the app renders in the
  // panel, mainloop() returns (the run finishes), and the button still drives
  // the Python callback which updates the label through the variable.
  await setActiveFile(page, 'gui.py')
  await expect(page.getByRole('button', { name: /Run gui\.py/ })).toBeEnabled()
  await page.getByRole('button', { name: /Run gui\.py/ }).click()
  await expect.poll(() => termText(page), { timeout: 120_000 }).toContain('gui ready')
  const guiWindow = sandboxFrame(page).locator('[data-tk-kind="window"]')
  await expect(guiWindow).toBeVisible()
  await expect(guiWindow.locator('[data-tk-kind="label"]')).toHaveText('0')
  await guiWindow.locator('[data-tk-kind="button"]').click()
  await expect(guiWindow.locator('[data-tk-kind="label"]')).toHaveText('1')

  // The turtle wheel ships in the image. A deployment built without it degrades to a
  // "not bundled" message — which is exactly what this assertion turns red.
  await pushLine(page, 'import turtle')
  await expect.poll(() => termStage(page), { timeout: 60_000 }).toBe('ready')
  expect(await termText(page)).not.toContain('not bundled in this deployment')
  const beforeTurtle = await sandboxFrame(page).evaluate(
    () => window.__termDebug?.graphicsCount() ?? -1,
  )
  await pushLine(page, 't = turtle.Turtle()')
  await expect.poll(() => termStage(page), { timeout: 60_000 }).toBe('ready')
  await pushLine(page, 't.forward(80)')
  await expect
    .poll(
      () => sandboxFrame(page).evaluate(() => window.__termDebug?.graphicsCount() ?? -1),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(beforeTurtle)

  // Stop kills an infinite loop and stays stopped; Start boots a fresh session.
  await pushLine(page, 'while True: pass')
  await page.getByRole('button', { name: 'Stop' }).click()
  await page.locator('[data-testid="sandbox-stopped"]').waitFor()
  await page.getByRole('button', { name: 'Start' }).click()
  await expect.poll(() => termStage(page), { timeout: 240_000 }).toBe('ready')
  await pushLine(page, 'print("alive")')
  await expect.poll(() => termText(page), { timeout: 60_000 }).toContain('alive')
})
