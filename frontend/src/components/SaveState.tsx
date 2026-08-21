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
  // The clock lives in state so render stays pure; the first paint after a save shows
  // "0s ago" until the next tick catches up.
  const [now, setNow] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
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
  const seconds = Math.max(0, Math.round((now - lastSavedAt) / 1000))
  return (
    <span className="text-muted text-xs" data-testid="save-state">
      saved {String(seconds)}s ago
    </span>
  )
}
