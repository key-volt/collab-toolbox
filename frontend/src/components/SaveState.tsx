import { useEffect, useState } from 'react'

// A quiet line driven by the snapshot loop. On a dropped socket it turns danger and
// says so — edits stay local until the room reconnects.
export function SaveState({
  connected,
  lastSavedAt,
}: {
  connected: boolean
  lastSavedAt: number | null
}) {
  const [, forceTick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      forceTick((value) => value + 1)
    }, 5000)
    return () => clearInterval(timer)
  }, [])

  if (!connected) {
    return (
      <span className="text-danger text-xs" data-testid="save-state">
        offline — edits are local until the connection returns
      </span>
    )
  }
  if (lastSavedAt === null) {
    return (
      <span className="text-muted text-xs" data-testid="save-state">
        not saved yet
      </span>
    )
  }
  const seconds = Math.max(0, Math.round((Date.now() - lastSavedAt) / 1000))
  return (
    <span className="text-muted text-xs" data-testid="save-state">
      saved {String(seconds)}s ago
    </span>
  )
}
