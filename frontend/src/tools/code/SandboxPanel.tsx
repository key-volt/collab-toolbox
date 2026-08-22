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

const FRAME_SRC = '/sandbox/run.html'

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
  const [frameEpoch, setFrameEpoch] = useState(0)
  const loadsRef = useRef(0)

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
      } else if (data.type === 'stage' && typeof data.stage === 'string') {
        setStage(typeof data.detail === 'string' ? `${data.stage}: ${data.detail}` : data.stage)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [getFiles, post])

  const runnable =
    activePath !== null && (activePath.endsWith('.py') || activePath.endsWith('.js'))

  const run = () => {
    if (activePath === null) return
    post({ type: 'run', path: activePath, files: getFiles() })
  }

  const stop = () => post({ type: 'stop' })

  const reset = useCallback(() => {
    loadsRef.current = 0
    setStage('starting')
    setFrameEpoch((epoch) => epoch + 1)
  }, [])

  // The sandbox cannot be stopped from navigating itself, but a navigation is always
  // visible as an extra load event — and the answer to one is a fresh frame.
  const onFrameLoad = () => {
    loadsRef.current += 1
    if (loadsRef.current > 1) reset()
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
            Run {runnable && activePath !== null ? baseName(activePath) : ''}
          </Button>
          <Button onClick={stop}>Stop</Button>
          <Button onClick={reset}>Reset</Button>
          <Button onClick={onClose}>Close</Button>
        </div>
      </header>
      <iframe
        key={frameEpoch}
        ref={frameRef}
        src={FRAME_SRC}
        sandbox="allow-scripts"
        title="Code sandbox"
        className="min-h-0 w-full flex-1 border-0 bg-bg"
        onLoad={onFrameLoad}
      />
    </div>
  )
}
