import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'

import { usePresence } from '../../App'
import { HistoryPanel } from '../../components/HistoryPanel'
import { SaveState } from '../../components/SaveState'
import { TitleEditor } from '../../components/TitleEditor'
import { Button } from '../../components/ui'
import { api, apiText, getAccessToken, refreshSession } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import {
  colorFor,
  isElected,
  peersFrom,
  publishSaveOutcome,
  RoomSession,
  watchSaves,
} from '../../lib/collab'
import { pushSnapshot, type ToolsInfo } from '../../lib/snapshots'
import { LOCAL_ORIGIN, xml2ydoc, ydoc2xml } from '../../vendor/y-mxgraph'
import {
  createIframeBridgeServer,
  type IframeBridgeServer,
} from '../../vendor/y-mxgraph/iframe-bridge'

interface DocumentDetail {
  id: string
  tool: string
  title: string
  access: 'read' | 'edit' | 'manage'
}

const FILENAME = 'document.drawio'

export function DrawioEditor({ docId }: { docId: string }) {
  const { user } = useAuth()
  const { setPeers } = usePresence()
  const navigate = useNavigate()

  const [detail, setDetail] = useState<DocumentDetail | null>(null)
  const [connected, setConnected] = useState(false)
  const [denied, setDenied] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [autosaveSeconds, setAutosaveSeconds] = useState(10)
  // 'static' is the reader-facing fallback: nobody has seeded the live room, so the
  // last save is shown from the stored file instead of a blank diagram.
  const [mode, setMode] = useState<'live' | 'static'>('live')

  const sessionRef = useRef<RoomSession | null>(null)
  // The static copy has no provider; the bridge still needs an awareness object.
  const staticAwarenessRef = useRef<Awareness | null>(null)
  const bridgeRef = useRef<IframeBridgeServer | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    api<DocumentDetail>(`/api/documents/${docId}`).then(setDetail).catch(() => setDenied(true))
    api<ToolsInfo>('/api/tools')
      .then((info) => setAutosaveSeconds(info.autosave_seconds))
      .catch(() => undefined)
  }, [docId])

  // The room plus the postMessage bridge into the editor iframe. The parent owns the
  // network connection and the undo manager; the child owns draw.io. Readers join the
  // same room but never write; a reader facing a never-seeded room switches to a
  // static local copy of the last save instead.
  const access = detail?.access ?? null
  useEffect(() => {
    const iframe = iframeRef.current
    if (iframe === null || access === null) return
    const canEdit = access !== 'read'
    let cancelled = false

    const session = new RoomSession(
      'drawio',
      docId,
      getAccessToken,
      async () => (await refreshSession())?.accessToken ?? null,
      {
        onStatus: setConnected,
        onDenied: () => setDenied(true),
        onSynced: () => {
          void (canEdit ? seed() : readerProbe())
        },
      },
    )
    sessionRef.current = session

    // Its own function on purpose: the cancellation flag is mutated from the cleanup
    // closure, which TypeScript's narrowing cannot see — a second read in the same
    // function after an earlier guard would be "provably" falsy to the linter. Here
    // the post-await read is the function's first, so it keeps its honest type.
    const applyStored = async () => {
      const stored = await apiText(`/api/documents/${docId}/files/${FILENAME}`)
      if (cancelled) return
      xml2ydoc(stored, session.doc)
    }

    async function seed() {
      const awareness = session.awareness
      if (awareness === null) return
      if (session.doc.getMap('mxfile').size > 0) return
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (cancelled || session.doc.getMap('mxfile').size > 0 || !isElected(awareness)) return
      await applyStored()
    }

    async function readerProbe() {
      // A reader must never seed the shared room — the server would drop the writes.
      // If nobody has seeded it, show the stored file statically instead.
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (cancelled) return
      if (session.doc.getMap('mxfile').size === 0) setMode('static')
    }

    // No initializer: both branches assign, so an initial null would be dead code.
    let awareness: Awareness | null
    if (mode === 'static') {
      awareness = new Awareness(session.doc)
      staticAwarenessRef.current = awareness
      void applyStored()
    } else {
      session.connect()
      awareness = session.awareness
      if (awareness !== null && user !== null) {
        awareness.setLocalStateField('user', {
          name: user.username,
          color: colorFor(user.id),
          canEdit,
        })
        const roster = awareness
        const mirrorSaves = watchSaves(
          roster,
          () => {
            setSavedAt(Date.now())
            setSaveError(null)
          },
          (reason) => setSaveError(reason),
        )
        const publishPeers = () => {
          mirrorSaves()
          setPeers(peersFrom(roster))
        }
        roster.on('change', publishPeers)
        publishPeers()
      }
    }
    if (awareness === null) {
      return () => {
        cancelled = true
        session.destroy()
        sessionRef.current = null
      }
    }

    const undoManager = new Y.UndoManager(session.doc.getMap('mxfile'), {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
    })
    const bridge = createIframeBridgeServer(iframe, session.doc, awareness, { undoManager })
    bridgeRef.current = bridge

    return () => {
      cancelled = true
      const finalAwareness = session.awareness
      if (canEdit && finalAwareness !== null && isElected(finalAwareness)) {
        const xml = ydoc2xml(session.doc, 2)
        if (xml.includes('<diagram')) {
          void pushSnapshot('drawio', docId, xml, 'application/xml', true)
        }
      }
      setPeers([])
      bridge.destroy()
      bridgeRef.current = null
      undoManager.destroy()
      staticAwarenessRef.current?.destroy()
      staticAwarenessRef.current = null
      session.destroy()
      sessionRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one room per document, mode and access
  }, [docId, access, mode])

  // The elected client persists the document on the autosave cadence. Readers never
  // push — the election excludes them, and the server would refuse the push anyway.
  useEffect(() => {
    if (access === 'read' || access === null) return
    const timer = setInterval(() => {
      const session = sessionRef.current
      const awareness = session?.awareness ?? null
      if (session === null || awareness === null || !isElected(awareness)) return
      const xml = ydoc2xml(session.doc, 2)
      if (!xml.includes('<diagram')) return
      void pushSnapshot('drawio', docId, xml, 'application/xml')
        .then((failure) => {
          if (sessionRef.current === session) publishSaveOutcome(awareness, failure)
        })
        .catch(() => {
          if (sessionRef.current === session) publishSaveOutcome(awareness, 'connection failed')
        })
    }, autosaveSeconds * 1000)
    return () => clearInterval(timer)
  }, [autosaveSeconds, docId, access])

  const restoreVersion = useCallback((_filename: string, content: string) => {
    const session = sessionRef.current
    if (session === null) return
    // Applied as an ordinary document update: it syncs to every client, and the next
    // autosave writes it back as a new version — restore never destroys anything.
    xml2ydoc(content, session.doc)
  }, [])

  if (denied) {
    return (
      <div className="text-muted flex h-full flex-col items-center justify-center gap-3 text-sm">
        <p>This document is not available.</p>
        <Button onClick={() => void navigate('/')}>Back to documents</Button>
      </div>
    )
  }

  const canMutate = access !== null && access !== 'read'
  const canManage = access === 'manage'

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
          <Link to="/t/drawio" className="text-muted hover:text-text text-sm">
            ←
          </Link>
          {detail !== null &&
            (canManage ? (
              <TitleEditor key={detail.title} docId={docId} title={detail.title} />
            ) : (
              <span className="truncate text-sm font-medium">{detail.title}</span>
            ))}
          <div className="ml-auto flex items-center gap-3">
            {canMutate && (
              <SaveState connected={connected} lastSavedAt={savedAt} error={saveError} />
            )}
            <Button onClick={() => setHistoryOpen((open) => !open)}>History</Button>
          </div>
        </header>
        {mode === 'static' && (
          <div className="text-muted flex shrink-0 items-center gap-3 border-b border-border bg-raised px-3 py-1.5 text-xs">
            <span>Static view of the last save — reload to check for live editors.</span>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        )}
        {detail === null ? (
          <div className="text-muted flex min-h-0 flex-1 items-center justify-center text-sm">
            loading the editor…
          </div>
        ) : (
          /* A mode switch reboots the child so it binds the fresh document cleanly. */
          <iframe
            key={mode}
            ref={iframeRef}
            title="Diagram editor"
            src={`/drawio/editor.html${canMutate ? '' : '?readonly=1'}`}
            sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-modals"
            className="min-h-0 w-full flex-1 border-0 bg-bg"
          />
        )}
      </div>
      {historyOpen && (
        <HistoryPanel
          docId={docId}
          canRestore={canMutate}
          onClose={() => setHistoryOpen(false)}
          onRestore={restoreVersion}
        />
      )}
    </div>
  )
}
