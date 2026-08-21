import { useCallback, useEffect, useState } from 'react'

import { Button, Dialog, ErrorLine, Field, TextInput } from '../components/ui'
import { api } from '../lib/api'

interface UserRow {
  id: string
  username: string
  is_admin: boolean
  is_whitelisted: boolean
  created_at: string
}

export function AdminUsers() {
  const [rows, setRows] = useState<UserRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<UserRow | null>(null)

  const reload = useCallback(() => {
    api<UserRow[]>('/api/admin/users')
      .then(setRows)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not load users')
      })
  }, [])

  useEffect(reload, [reload])

  const toggle = (row: UserRow) => {
    api<UserRow>(`/api/admin/users/${row.id}`, {
      method: 'PATCH',
      json: { is_whitelisted: !row.is_whitelisted },
    })
      .then(reload)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not update the user')
      })
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Users</h1>
        <Button variant="primary" onClick={() => setAdding(true)}>
          + Add user
        </Button>
      </div>
      <ErrorLine message={error} />
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead className="text-muted bg-surface text-xs">
            <tr>
              <th className="px-4 py-2 font-normal">Username</th>
              <th className="px-4 py-2 font-normal">Whitelisted</th>
              <th className="px-4 py-2 font-normal">Password</th>
              <th className="px-4 py-2 font-normal">Created</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row) => (
              <tr key={row.id} className="border-t border-border">
                <td className="px-4 py-2">
                  {row.username}
                  {row.is_admin && <span className="text-muted ml-2 text-xs">administrator</span>}
                </td>
                <td className="px-4 py-2">
                  {row.is_admin ? (
                    <span className="text-muted text-xs">always</span>
                  ) : (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={row.is_whitelisted}
                      aria-label={`Whitelist ${row.username}`}
                      onClick={() => toggle(row)}
                      className={`h-5 w-9 rounded-full border transition ${
                        row.is_whitelisted ? 'border-accent bg-accent' : 'border-border bg-raised'
                      }`}
                    >
                      <span
                        className={`block h-3.5 w-3.5 rounded-full bg-white transition ${
                          row.is_whitelisted ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  )}
                </td>
                <td className="text-muted px-4 py-2 text-xs">
                  {row.is_admin
                    ? 'set in /run/secrets/admin_password on the host'
                    : 'set by the user'}
                </td>
                <td className="text-muted px-4 py-2 text-xs">{row.created_at.slice(0, 10)}</td>
                <td className="px-4 py-2 text-right">
                  {!row.is_admin && (
                    <button
                      type="button"
                      className="text-muted hover:text-danger text-xs"
                      onClick={() => setRemoving(row)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <AddUserDialog
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false)
            reload()
          }}
        />
      )}
      {removing !== null && (
        <Dialog open onOpenChange={(next) => !next && setRemoving(null)} title="Delete user">
          <div className="space-y-4">
            <p className="text-muted text-sm">
              Delete <span className="text-text">{removing.username}</span>? Their documents are
              unaffected; their sessions end immediately.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setRemoving(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  api<undefined>(`/api/admin/users/${removing.id}`, { method: 'DELETE' })
                    .then(() => {
                      setRemoving(null)
                      reload()
                    })
                    .catch((cause: unknown) => {
                      setError(cause instanceof Error ? cause.message : 'could not delete')
                      setRemoving(null)
                    })
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}

function AddUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  // Mounted only while open, so every opening starts from a clean slate.
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = () => {
    setBusy(true)
    setError(null)
    api<UserRow>('/api/admin/users', { method: 'POST', json: { username, password } })
      .then(onCreated)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not create the user')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()} title="Add user">
      <div className="space-y-4">
        <Field label="Username">
          <TextInput autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Initial password (at least 8 characters)">
          <TextInput
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorLine message={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || username.trim() === '' || password.length < 8}
            onClick={create}
          >
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
