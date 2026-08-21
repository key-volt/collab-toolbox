import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useNavigate, useParams } from 'react-router'

import { Button, Dialog, ErrorLine, Field, TextInput } from './components/ui'
import { PresenceStack } from './components/PresenceStack'
import { api } from './lib/api'
import { AuthProvider, useAuth } from './lib/auth'
import type { Peer } from './lib/collab'
import { AdminTrash } from './pages/AdminTrash'
import { AdminUsers } from './pages/AdminUsers'
import { Documents } from './pages/Documents'
import { Login } from './pages/Login'
import { Pending } from './pages/Pending'
import { TOOLS } from './tools'

const PaintEditor = lazy(() =>
  import('./tools/paint/PaintEditor').then((module) => ({ default: module.PaintEditor })),
)
const DrawioEditor = lazy(() =>
  import('./tools/drawio/DrawioEditor').then((module) => ({ default: module.DrawioEditor })),
)

interface PresenceContextValue {
  peers: Peer[]
  setPeers: (peers: Peer[]) => void
}

const PresenceContext = createContext<PresenceContextValue | null>(null)

export function usePresence(): PresenceContextValue {
  const value = useContext(PresenceContext)
  if (value === null) throw new Error('usePresence must be used inside the shell')
  return value
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireSession />}>
            <Route path="/pending" element={<Pending />} />
            <Route element={<Shell />}>
              <Route path="/" element={<Documents />} />
              <Route path="/t/:tool" element={<Documents />} />
              <Route path="/t/:tool/:docId" element={<EditorRoute />} />
              <Route element={<RequireAdmin />}>
                <Route path="/admin/users" element={<AdminUsers />} />
                <Route path="/admin/trash" element={<AdminTrash />} />
              </Route>
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

function RequireSession() {
  const { user, ready } = useAuth()
  if (!ready) {
    return <main className="text-muted flex min-h-dvh items-center justify-center text-sm">…</main>
  }
  if (user === null) {
    return <Navigate to="/login" replace />
  }
  return <Outlet />
}

function RequireAdmin() {
  const { user } = useAuth()
  if (user?.is_admin !== true) {
    return <Navigate to="/" replace />
  }
  return <Outlet />
}

function Shell() {
  const { user } = useAuth()
  const [peers, setPeers] = useState<Peer[]>([])
  const presence = useMemo(() => ({ peers, setPeers }), [peers])

  if (user !== null && !user.is_whitelisted) {
    return <Navigate to="/pending" replace />
  }

  return (
    <PresenceContext.Provider value={presence}>
      <div className="flex h-dvh flex-col">
        <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border px-4">
          <NavLink to="/" className="text-sm font-medium tracking-tight">
            collab-toolbox
          </NavLink>
          <div className="ml-auto flex items-center gap-4">
            <PresenceStack peers={peers} />
            <AccountMenu />
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <Sidebar />
          <main className="min-h-0 min-w-0 flex-1 overflow-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </PresenceContext.Provider>
  )
}

function Sidebar() {
  const { user } = useAuth()
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `block rounded-md px-3 py-1.5 text-sm transition ${
      isActive ? 'bg-raised text-text' : 'text-muted hover:text-text'
    }`
  return (
    <nav className="w-44 shrink-0 space-y-1 border-r border-border p-3">
      <NavLink to="/" end className={linkClass}>
        All documents
      </NavLink>
      {TOOLS.map((tool) => (
        <NavLink key={tool.slug} to={`/t/${tool.slug}`} end className={linkClass}>
          <span aria-hidden className="mr-2">
            {tool.glyph}
          </span>
          {tool.title}
        </NavLink>
      ))}
      {user?.is_admin === true && (
        <>
          <p className="text-muted px-3 pt-4 pb-1 text-xs">Admin</p>
          <NavLink to="/admin/users" className={linkClass}>
            ⚙ Users
          </NavLink>
          <NavLink to="/admin/trash" className={linkClass}>
            ⌫ Trash
          </NavLink>
        </>
      )}
    </nav>
  )
}

function AccountMenu() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [changingPassword, setChangingPassword] = useState(false)

  if (user === null) return null

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="text-muted hover:text-text rounded-md px-2 py-1 text-sm transition">
          {user.username} ▾
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="w-64 rounded-md border border-border bg-surface p-1 text-sm"
          >
            {user.is_admin ? (
              <div className="text-muted px-3 py-2 text-xs">
                Password is file-managed: set in /run/secrets/admin_password on the host.
              </div>
            ) : (
              <DropdownMenu.Item
                className="cursor-pointer rounded px-3 py-1.5 outline-none data-[highlighted]:bg-raised"
                onSelect={() => setChangingPassword(true)}
              >
                Change password
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item
              className="cursor-pointer rounded px-3 py-1.5 outline-none data-[highlighted]:bg-raised"
              onSelect={() => {
                void signOut().then(() => navigate('/login', { replace: true }))
              }}
            >
              Sign out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ChangePasswordDialog open={changingPassword} onOpenChange={setChangingPassword} />
    </>
  )
}

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = () => {
    setBusy(true)
    setError(null)
    api<undefined>('/api/auth/password', {
      method: 'POST',
      json: { current_password: current, new_password: next },
    })
      .then(() => {
        onOpenChange(false)
        setCurrent('')
        setNext('')
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'could not change the password')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Change password">
      <div className="space-y-4">
        <Field label="Current password">
          <TextInput
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </Field>
        <Field label="New password (at least 8 characters)">
          <TextInput
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </Field>
        <ErrorLine message={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={busy || next.length < 8} onClick={submit}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function EditorRoute() {
  const { tool, docId } = useParams()
  if (tool === undefined || docId === undefined) {
    return <Navigate to="/" replace />
  }
  const fallback = (
    <div className="text-muted flex h-full items-center justify-center text-sm">
      loading the editor…
    </div>
  )
  if (tool === 'paint') {
    return (
      <Suspense fallback={fallback}>
        <PaintEditor docId={docId} />
      </Suspense>
    )
  }
  if (tool === 'drawio') {
    return (
      <Suspense fallback={fallback}>
        <DrawioEditor docId={docId} />
      </Suspense>
    )
  }
  return <Navigate to="/" replace />
}
