import { useEffect, useState } from 'react'

import { readServiceStatus, type ServiceStatus } from './lib/health'

export function App() {
  const [status, setStatus] = useState<ServiceStatus>('checking')

  useEffect(() => {
    let active = true
    void readServiceStatus().then((next) => {
      if (active) {
        setStatus(next)
      }
    })
    return () => {
      active = false
    }
  }, [])

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3">
      <h1 className="text-2xl tracking-tight">collab-toolbox</h1>
      <p className="text-muted text-sm">
        service <span data-testid="service-status">{status}</span>
      </p>
    </main>
  )
}
