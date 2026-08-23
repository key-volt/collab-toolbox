import { useEffect, useState } from 'react'

import { api } from '../lib/api'
import { Button, Dialog, EmptyState, ErrorLine } from './ui'

type GrantLevel = 'none' | 'read' | 'edit'

interface AccessInfo {
  owner: string | null
  entries: { user_id: string; username: string; level: 'read' | 'edit' }[]
  candidates: { id: string; username: string }[]
}

const LEVELS: { value: GrantLevel; label: string }[] = [
  { value: 'none', label: 'No access' },
  { value: 'read', label: 'Read' },
  { value: 'edit', label: 'Edit' },
]

// Per-user grants for one document. Admins and the owner are never listed — they
// always have access. Saving replaces the whole grant list; anyone whose access
// shrinks is cut off immediately, open editors included.
export function AccessDialog({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [info, setInfo] = useState<AccessInfo | null>(null)
  const [levels, setLevels] = useState<Record<string, GrantLevel>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<AccessInfo>(`/api/documents/${docId}/access`)
      .then((loaded) => {
        setInfo(loaded)
        const initial: Record<string, GrantLevel> = {}
        for (const candidate of loaded.candidates) initial[candidate.id] = 'none'
        for (const entry of loaded.entries) initial[entry.user_id] = entry.level
        setLevels(initial)
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not load access')
      })
  }, [docId])

  const save = () => {
    setBusy(true)
    setError(null)
    const entries = Object.entries(levels)
      .filter(([, level]) => level !== 'none')
      .map(([userId, level]) => ({ user_id: userId, level }))
    api<AccessInfo>(`/api/documents/${docId}/access`, { method: 'PUT', json: { entries } })
      .then(onClose)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not save access')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()} title="Access">
      <div className="space-y-4">
        <p className="text-muted text-xs">
          Read shows the document; edit allows changing it. Removing access cuts the
          person off immediately, even mid-edit. Admins
          {info?.owner != null ? ` and the owner (${info.owner})` : ''} always have access.
        </p>
        <ErrorLine message={error} />
        {info !== null && info.candidates.length === 0 && (
          <EmptyState>No other approved accounts to share with.</EmptyState>
        )}
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {(info?.candidates ?? []).map((candidate) => (
            <li key={candidate.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-sm">{candidate.username}</span>
              <span className="flex shrink-0 gap-1">
                {LEVELS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={levels[candidate.id] === option.value}
                    className={`rounded-md border px-2 py-0.5 text-xs transition ${
                      levels[candidate.id] === option.value
                        ? 'border-accent bg-accent text-white'
                        : 'text-muted hover:text-text border-border bg-raised'
                    }`}
                    onClick={() =>
                      setLevels((current) => ({ ...current, [candidate.id]: option.value }))
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || info === null} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
