import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { Button, ErrorLine, Field, TextInput } from '../components/ui'
import { useAuth } from '../lib/auth'
import { readServiceStatus, type ServiceStatus } from '../lib/health'

export function Login() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ServiceStatus>('checking')

  useEffect(() => {
    let active = true
    void readServiceStatus().then((next) => {
      if (active) setStatus(next)
    })
    return () => {
      active = false
    }
  }, [])

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    signIn(username, password)
      .then((user) => {
        void navigate(user.is_whitelisted ? '/' : '/pending', { replace: true })
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'login failed')
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <h1 className="text-2xl tracking-tight">collab-toolbox</h1>
      <form
        onSubmit={submit}
        className="w-full max-w-xs space-y-4 rounded-lg border border-border bg-surface p-5"
      >
        <Field label="Username">
          <TextInput
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field label="Password">
          <TextInput
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <ErrorLine message={error} />
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          disabled={busy || username === '' || password === ''}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="text-muted text-sm">
        service <span data-testid="service-status">{status}</span>
      </p>
    </main>
  )
}
