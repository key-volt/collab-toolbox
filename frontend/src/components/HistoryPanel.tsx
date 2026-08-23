import { useCallback, useEffect, useState } from 'react'

import { api, apiText } from '../lib/api'
import { Button, EmptyState, ErrorLine } from './ui'

export interface VersionRow {
  name: string
  filename: string
  stamp: string
  size: number
}

function formatStamp(stamp: string): string {
  // 20260821T141530Z → 2026-08-21 14:15
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(stamp)
  if (match === null) return stamp
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`
}

function formatSize(size: number): string {
  if (size < 1024) return `${String(size)} B`
  return `${(size / 1024).toFixed(1)} kB`
}

// Restore writes a new version rather than replacing anything, so this panel is safe
// to explore — the copy says so on its face. Read-only visitors browse and preview;
// the restore button itself needs edit access.
export function HistoryPanel({
  docId,
  canRestore = true,
  onClose,
  onRestore,
}: {
  docId: string
  canRestore?: boolean
  onClose: () => void
  onRestore: (filename: string, content: string) => Promise<void> | void
}) {
  const [versions, setVersions] = useState<VersionRow[] | null>(null)
  const [selected, setSelected] = useState<VersionRow | null>(null)
  const [loaded, setLoaded] = useState<{ name: string; content: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The preview belongs to the selection it was fetched for; a stale one never shows.
  const preview = selected !== null && loaded?.name === selected.name ? loaded.content : null

  const reload = useCallback(() => {
    api<VersionRow[]>(`/api/documents/${docId}/versions`)
      .then(setVersions)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not load versions')
      })
  }, [docId])

  useEffect(reload, [reload])

  useEffect(() => {
    if (selected === null) return
    let active = true
    apiText(`/api/documents/${docId}/versions/${selected.name}`)
      .then((content) => {
        if (active) setLoaded({ name: selected.name, content })
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [docId, selected])

  const restore = async () => {
    if (selected === null || preview === null) return
    setBusy(true)
    setError(null)
    try {
      await onRestore(selected.filename, preview)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'restore failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-surface">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">History</h2>
          <p className="text-muted text-xs">Restoring never deletes — it adds a new version.</p>
        </div>
        <Button onClick={onClose}>Close</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <ErrorLine message={error} />
        {versions !== null && versions.length === 0 && (
          <EmptyState>No versions yet — they appear as the document changes.</EmptyState>
        )}
        <ul className="space-y-1">
          {(versions ?? []).map((version) => (
            <li key={version.name}>
              <button
                type="button"
                onClick={() => setSelected(version)}
                className={`w-full rounded-md px-3 py-2 text-left text-xs transition ${
                  selected?.name === version.name ? 'bg-raised' : 'hover:bg-raised/60'
                }`}
              >
                <span className="block">{formatStamp(version.stamp)}</span>
                <span className="text-muted">
                  {version.filename} · {formatSize(version.size)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {selected !== null && (
        <footer className="space-y-2 border-t border-border p-3">
          <pre className="text-muted max-h-32 overflow-auto rounded-md bg-bg p-2 text-[10px]">
            {preview === null ? 'loading…' : preview.slice(0, 2000)}
          </pre>
          {canRestore && (
            <Button
              variant="primary"
              className="w-full"
              disabled={busy || preview === null}
              onClick={() => void restore()}
            >
              {busy ? 'Restoring…' : 'Restore this version'}
            </Button>
          )}
        </footer>
      )}
    </aside>
  )
}
