import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { Button, ErrorLine, Field, TextInput } from '../components/ui'
import { register } from '../lib/api'

// The proof-of-work widget solves a challenge from our own backend in the background;
// nothing here talks to a third party. Until it reports solved, submit stays off.
export function Register() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [payload, setPayload] = useState<string | null>(null)
  const [widgetReady, setWidgetReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const widgetRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let active = true
    import('altcha')
      .then(() => {
        if (active) setWidgetReady(true)
      })
      .catch(() => {
        if (active) setError('the captcha widget failed to load')
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const widget = widgetRef.current
    if (widget === null || !widgetReady) return
    const onStateChange = (event: Event) => {
      const detail = (event as CustomEvent<{ state?: string; payload?: string }>).detail
      setPayload(detail.state === 'verified' && typeof detail.payload === 'string' ? detail.payload : null)
    }
    widget.addEventListener('statechange', onStateChange)
    return () => widget.removeEventListener('statechange', onStateChange)
  }, [widgetReady])

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    if (payload === null) return
    setBusy(true)
    setError(null)
    register(username.trim(), password, payload)
      .then(() => {
        void navigate('/pending', { replace: true })
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'registration failed')
        setPayload(null)
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
        <p className="text-muted text-sm">
          Register an account. It needs approval by the administrator before it can see
          anything.
        </p>
        <Field label="Username (3–32 characters: letters, digits, . _ -)">
          <TextInput
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </Field>
        <Field label="Password (at least 8 characters)">
          <TextInput
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {widgetReady && (
          <altcha-widget
            ref={(node: HTMLElement | null) => {
              widgetRef.current = node
            }}
            challenge="/api/auth/register/challenge"
            name="altcha"
          />
        )}
        <ErrorLine message={error} />
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          disabled={busy || username.trim() === '' || password.length < 8 || payload === null}
        >
          {busy ? 'Registering…' : payload === null ? 'Waiting for the captcha…' : 'Register'}
        </Button>
      </form>
      <p className="text-muted text-sm">
        Already have an account?{' '}
        <Link to="/login" className="text-text underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </main>
  )
}
