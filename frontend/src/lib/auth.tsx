import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import {
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  onSessionChange,
  refreshSession,
  type SessionUser,
} from './api'

interface AuthContextValue {
  user: SessionUser | null
  ready: boolean
  signIn: (username: string, password: string) => Promise<SessionUser>
  signOut: () => Promise<void>
  reloadUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const unsubscribe = onSessionChange((session) => {
      setUser(session?.user ?? null)
    })
    void refreshSession().finally(() => {
      setReady(true)
    })
    return unsubscribe
  }, [])

  const signIn = useCallback(async (username: string, password: string) => {
    const session = await apiLogin(username, password)
    return session.user
  }, [])

  const signOut = useCallback(async () => {
    await apiLogout()
  }, [])

  const reloadUser = useCallback(async () => {
    try {
      setUser(await fetchMe())
    } catch {
      setUser(null)
    }
  }, [])

  const value = useMemo(
    () => ({ user, ready, signIn, signOut, reloadUser }),
    [user, ready, signIn, signOut, reloadUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === null) {
    throw new Error('useAuth must be used inside AuthProvider')
  }
  return value
}
