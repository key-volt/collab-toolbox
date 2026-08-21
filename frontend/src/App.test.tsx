import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { App } from './App'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubFetch(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ json: () => Promise.resolve(body) })),
  )
}

test('renders the product name and the status the backend reports', async () => {
  stubFetch({ status: 'ok' })

  render(<App />)

  expect(screen.getByRole('heading', { name: 'collab-toolbox' })).toBeDefined()
  await waitFor(() => {
    expect(screen.getByTestId('service-status').textContent).toBe('ok')
  })
})

test('reports unavailable when the request fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  )

  render(<App />)

  await waitFor(() => {
    expect(screen.getByTestId('service-status').textContent).toBe('unavailable')
  })
})
