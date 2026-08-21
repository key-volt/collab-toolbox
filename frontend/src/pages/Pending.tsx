import { useNavigate } from 'react-router'

import { useAuth } from '../lib/auth'

// No nav, no sidebar: whitelisting is all-or-nothing, so there is nothing partial to
// show an account that is still waiting.
export function Pending() {
  const { signOut } = useAuth()
  const navigate = useNavigate()

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <p className="text-lg">Your account is waiting for approval.</p>
      <button
        type="button"
        className="text-muted text-sm underline-offset-4 hover:underline"
        onClick={() => {
          void signOut().then(() => navigate('/login', { replace: true }))
        }}
      >
        Sign out
      </button>
    </main>
  )
}
