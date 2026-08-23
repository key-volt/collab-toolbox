// The terminal panel: an opaque-origin sandboxed iframe hosting the interpreter, and
// the only bridge to it is postMessage. The frame gets copies of the project files and
// nothing else — no cookies, no token, no parent DOM, no network beyond our own
// /sandbox/ assets. Execution is per user; nothing here is shared or written back.

import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '../../components/ui'
import { baseName } from './paths'

export interface SandboxFile {
  path: string
  text: string
}

interface FrameMessage {
  type?: unknown
  stage?: unknown
  detail?: unknown
}

// The sandbox build emits index.html, served at the directory URL.
const FRAME_SRC = '/sandbox/'

export function SandboxPanel({
  getFiles,
  activePath,
  onClose,
}: {
  getFiles: () => SandboxFile[]
  activePath: string | null
  onClose: () => void
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [stage, setStage] = useState('starting')
  const [stopped, setStopped] = useState(false)
  const [frameEpoch, setFrameEpoch] = useState(0)
  const loadsRef = useRef(0)
  const pendingRunRef = useRef<string | null>(null)

  const post = useCallback((message: object) => {
    // targetOrigin has to be '*': an opaque origin has no name to address. Safe,
    // because this posts to the window object of the frame we created, never to a
    // location an attacker chooses.
    frameRef.current?.contentWindow?.postMessage(message, '*')
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow
      if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) return
      const data = event.data as FrameMessage
      if (data.type === 'sandbox-ready') {
        post({ type: 'files', files: getFiles() })
        const queuedRun = pendingRunRef.current
        if (queuedRun !== null) {
          pendingRunRef.current = null
          post({ type: 'run', path: queuedRun, files: getFiles() })
        }
      } else if (data.type === 'stage' && typeof data.stage === 'string') {
        setStage(typeof data.detail === 'string' ? `${data.stage}: ${data.detail}` : data.stage)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [getFiles, post])

  const runnable =
    activePath !== null && (activePath.endsWith('.py') || activePath.endsWith('.js'))

  const boot = useCallback(() => {
    loadsRef.current = 0
    setStopped(false)
    setStage('starting')
    setFrameEpoch((epoch) => epoch + 1)
  }, [])

  // Stop tears the frame down and leaves it down: it depends on nothing inside the
  // frame, so it works even while the sandbox is stuck in a hot loop, and nothing
  // boots again until Start (or Run) asks for it.
  const stop = () => {
    pendingRunRef.current = null
    setStopped(true)
    setStage('stopped')
  }

  const run = () => {
    if (activePath === null) return
    if (stopped) {
      // Boot first, run when the fresh frame reports ready.
      pendingRunRef.current = activePath
      boot()
      return
    }
    post({ type: 'run', path: activePath, files: getFiles() })
  }

  // The sandbox cannot be stopped from navigating itself, but a navigation is always
  // visible as an extra load event — and the answer to one is a fresh frame.
  const onFrameLoad = () => {
    loadsRef.current += 1
    if (loadsRef.current > 1) boot()
  }

  return (
    <div className="flex h-72 shrink-0 flex-col border-t border-border" data-testid="sandbox-panel">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-muted text-xs">Sandbox</span>
        <span className="text-muted truncate text-xs" data-testid="sandbox-stage">
          {stage}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button disabled={!runnable} onClick={run}>
            {/* `runnable` already proves activePath is non-null (aliased narrowing). */}
            Run {runnable ? baseName(activePath) : ''}
          </Button>
          <Button disabled={stopped} onClick={stop}>
            Stop
          </Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      </header>
      {stopped ? (
        <div
          className="text-muted flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 bg-bg text-sm"
          data-testid="sandbox-stopped"
        >
          <p>terminal stopped</p>
          <Button onClick={boot}>Start</Button>
        </div>
      ) : (
        <iframe
          key={frameEpoch}
          ref={frameRef}
          src={FRAME_SRC}
          sandbox="allow-scripts"
          title="Code sandbox"
          className="min-h-0 w-full flex-1 border-0 bg-bg"
          onLoad={onFrameLoad}
        />
      )}
    </div>
  )
}
