import { useCallback, useEffect, useState } from 'react'

import { Button, EmptyState, ErrorLine } from '../components/ui'
import { api } from '../lib/api'
import { toolInfo } from '../tools'

interface TrashRow {
  name: string
  title: string
  tool: string
  deleted_at: string
  purge_after: string
}

export function AdminTrash() {
  const [rows, setRows] = useState<TrashRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)

  const reload = useCallback(() => {
    api<TrashRow[]>('/api/admin/trash')
      .then(setRows)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not load the trash')
      })
  }, [])

  useEffect(reload, [reload])

  const restore = (row: TrashRow) => {
    setBusyName(row.name)
    setError(null)
    api<undefined>(`/api/admin/trash/${row.name}/restore`, { method: 'POST' })
      .then(reload)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not restore')
      })
      .finally(() => {
        setBusyName(null)
      })
  }

  return (
    <div className="space-y-4 p-6">
      <h1 className="text-lg font-medium">Trash</h1>
      <p className="text-muted text-sm">
        Deleted documents wait here until their retention runs out, then they are purged.
      </p>
      <ErrorLine message={error} />
      {rows !== null && rows.length === 0 && <EmptyState>The trash is empty.</EmptyState>}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead className="text-muted bg-surface text-xs">
            <tr>
              <th className="px-4 py-2 font-normal">Document</th>
              <th className="px-4 py-2 font-normal">Tool</th>
              <th className="px-4 py-2 font-normal">Deleted</th>
              <th className="px-4 py-2 font-normal">Purged after</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row) => (
              <tr key={row.name} className="border-t border-border">
                <td className="px-4 py-2">{row.title}</td>
                <td className="text-muted px-4 py-2 text-xs">
                  {toolInfo(row.tool)?.title ?? row.tool}
                </td>
                <td className="text-muted px-4 py-2 text-xs">{row.deleted_at.slice(0, 10)}</td>
                <td className="text-muted px-4 py-2 text-xs">{row.purge_after.slice(0, 10)}</td>
                <td className="px-4 py-2 text-right">
                  <Button disabled={busyName === row.name} onClick={() => restore(row)}>
                    {busyName === row.name ? 'Restoring…' : 'Restore'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
