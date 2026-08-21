import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { Button, Dialog, EmptyState, ErrorLine, Field, TextInput } from '../components/ui'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { TOOLS, toolInfo } from '../tools'

interface DocumentRow {
  id: string
  tool: string
  title: string
  created_at: string
  modified_at: string | null
  page_count: number
}

export function Documents() {
  const { tool: toolFilter } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [rows, setRows] = useState<DocumentRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<DocumentRow | null>(null)

  const reload = useCallback(() => {
    const query = toolFilter === undefined ? '' : `?tool=${encodeURIComponent(toolFilter)}`
    api<DocumentRow[]>(`/api/documents${query}`)
      .then(setRows)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not load documents')
      })
  }, [toolFilter])

  useEffect(reload, [reload])

  const heading =
    toolFilter === undefined ? 'All documents' : (toolInfo(toolFilter)?.title ?? toolFilter)

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">{heading}</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          New document
        </Button>
      </div>
      <ErrorLine message={error} />
      {rows !== null && rows.length === 0 && (
        <EmptyState>Nothing here yet — create the first document.</EmptyState>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {(rows ?? []).map((row) => (
          <div
            key={row.id}
            className="group relative rounded-md border border-border bg-surface transition hover:border-accent"
          >
            <Link to={`/t/${row.tool}/${row.id}`} className="block p-4">
              <div className="text-muted mb-2 flex items-center gap-2 text-xs">
                <span aria-hidden>{toolInfo(row.tool)?.glyph ?? '·'}</span>
                <span>{toolInfo(row.tool)?.title ?? row.tool}</span>
              </div>
              <h2 className="truncate text-sm font-medium">{row.title}</h2>
              <p className="text-muted mt-2 text-xs">
                {String(row.page_count)} {row.page_count === 1 ? 'page' : 'pages'}
                {row.modified_at !== null && ` · ${row.modified_at.slice(0, 10)}`}
              </p>
            </Link>
            {user?.is_admin === true && (
              <button
                type="button"
                aria-label={`Delete ${row.title}`}
                className="text-muted hover:text-danger absolute top-2 right-2 hidden rounded px-1.5 py-0.5 text-xs group-hover:block"
                onClick={() => setDeleting(row)}
              >
                Delete
              </button>
            )}
          </div>
        ))}
      </div>

      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        initialTool={toolFilter}
        onCreated={(row) => {
          void navigate(`/t/${row.tool}/${row.id}`)
        }}
      />
      {deleting !== null && (
        <DeleteDialog
          row={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

function CreateDialog({
  open,
  onOpenChange,
  initialTool,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTool: string | undefined
  onCreated: (row: { id: string; tool: string }) => void
}) {
  const [title, setTitle] = useState('')
  const [tool, setTool] = useState(initialTool ?? TOOLS[0]?.slug ?? 'drawio')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setTitle('')
      setTool(initialTool ?? TOOLS[0]?.slug ?? 'drawio')
      setError(null)
    }
  }, [open, initialTool])

  const create = () => {
    setBusy(true)
    setError(null)
    api<{ id: string; tool: string }>('/api/documents', {
      method: 'POST',
      json: { tool, title },
    })
      .then((row) => {
        onOpenChange(false)
        onCreated(row)
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not create the document')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New document">
      <div className="space-y-4">
        <Field label="Title">
          <TextInput
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="Tool">
          <select
            value={tool}
            onChange={(event) => setTool(event.target.value)}
            className="w-full rounded-md border border-border bg-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
          >
            {TOOLS.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.title}
              </option>
            ))}
          </select>
        </Field>
        <ErrorLine message={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={busy || title.trim() === ''} onClick={create}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function DeleteDialog({
  row,
  onClose,
  onDeleted,
}: {
  row: DocumentRow
  onClose: () => void
  onDeleted: () => void
}) {
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const remove = () => {
    setBusy(true)
    setError(null)
    api<undefined>(`/api/documents/${row.id}`, { method: 'DELETE' })
      .then(onDeleted)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not delete the document')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()} title="Delete document">
      <div className="space-y-4">
        <p className="text-muted text-sm">
          The document moves to the trash and stays restorable for a while. Type its title to
          confirm: <span className="text-text">{row.title}</span>
        </p>
        <TextInput
          autoFocus
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <ErrorLine message={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={busy || confirmation !== row.title} onClick={remove}>
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
