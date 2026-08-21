import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { App } from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/api/health')) {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok' }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      }
      // No session: the refresh endpoint answers 401 and the app lands on the login screen.
      return Promise.resolve(new Response(JSON.stringify({ detail: 'no session' }), { status: 401 }))
    }),
  )
}

test('without a session the app shows the login screen', async () => {
  stubFetch()

  render(<App />)

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'collab-toolbox' })).toBeDefined()
  })
  expect(screen.getByLabelText('Username')).toBeDefined()
  expect(screen.getByLabelText('Password')).toBeDefined()
})

test('the login screen reports the service status the backend gives it', async () => {
  stubFetch()

  render(<App />)

  await waitFor(() => {
    expect(screen.getByTestId('service-status').textContent).toBe('ok')
  })
})
