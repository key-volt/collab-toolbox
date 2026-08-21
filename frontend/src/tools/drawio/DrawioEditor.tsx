import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import * as Y from 'yjs'

import { usePresence } from '../../App'
import { HistoryPanel } from '../../components/HistoryPanel'
import { SaveState } from '../../components/SaveState'
import { TitleEditor } from '../../components/TitleEditor'
import { Button } from '../../components/ui'
import { api, apiText, getAccessToken, refreshSession } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { colorFor, isElected, peersFrom, RoomSession } from '../../lib/collab'
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
  const [historyOpen, setHistoryOpen] = useState(false)
  const [autosaveSeconds, setAutosaveSeconds] = useState(10)

  const sessionRef = useRef<RoomSession | null>(null)
  const bridgeRef = useRef<IframeBridgeServer | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    api<DocumentDetail>(`/api/documents/${docId}`).then(setDetail).catch(() => setDenied(true))
    api<ToolsInfo>('/api/tools')
      .then((info) => setAutosaveSeconds(info.autosave_seconds))
      .catch(() => undefined)
  }, [docId])

  // The room plus the postMessage bridge into the editor iframe. The parent owns the
  // network connection and the undo manager; the child owns draw.io.
  useEffect(() => {
    const iframe = iframeRef.current
    if (iframe === null) return

    const session = new RoomSession(
      'drawio',
      docId,
      getAccessToken,
      async () => (await refreshSession())?.accessToken ?? null,
      {
        onStatus: setConnected,
        onDenied: () => setDenied(true),
        onSynced: () => {
          void seed()
        },
      },
    )
    sessionRef.current = session

    async function seed() {
      const awareness = session.awareness
      if (awareness === null) return
      if (session.doc.getMap('mxfile').size > 0) return
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (session.doc.getMap('mxfile').size > 0 || !isElected(awareness)) return
      const stored = await apiText(`/api/documents/${docId}/files/${FILENAME}`)
      xml2ydoc(stored, session.doc)
    }

    session.connect()
    const awareness = session.awareness
    if (awareness === null) {
      return () => session.destroy()
    }
    if (user !== null) {
      awareness.setLocalStateField('user', { name: user.username, color: colorFor(user.id) })
    }
    const publishPeers = () => setPeers(peersFrom(awareness))
    awareness.on('change', publishPeers)
    publishPeers()

    const undoManager = new Y.UndoManager(session.doc.getMap('mxfile'), {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
    })
    const bridge = createIframeBridgeServer(iframe, session.doc, awareness, { undoManager })
    bridgeRef.current = bridge

    return () => {
      const finalAwareness = session.awareness
      if (finalAwareness !== null && isElected(finalAwareness)) {
        const xml = ydoc2xml(session.doc, 2)
        if (xml.includes('<diagram')) {
          void pushSnapshot('drawio', docId, xml, 'application/xml', true)
        }
      }
      setPeers([])
      bridge.destroy()
      bridgeRef.current = null
      undoManager.destroy()
      session.destroy()
      sessionRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one room per document
  }, [docId])

  // The elected client persists the document on the autosave cadence.
  useEffect(() => {
    const timer = setInterval(() => {
      const session = sessionRef.current
      const awareness = session?.awareness ?? null
      if (session === null || awareness === null || !isElected(awareness)) return
      const xml = ydoc2xml(session.doc, 2)
      if (!xml.includes('<diagram')) return
      void pushSnapshot('drawio', docId, xml, 'application/xml')
        .then(() => setSavedAt(Date.now()))
        .catch(() => undefined)
    }, autosaveSeconds * 1000)
    return () => clearInterval(timer)
  }, [autosaveSeconds, docId])

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

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
          <Link to="/t/drawio" className="text-muted hover:text-text text-sm">
            ←
          </Link>
          {detail !== null && <TitleEditor docId={docId} title={detail.title} />}
          <div className="ml-auto flex items-center gap-3">
            <SaveState connected={connected} lastSavedAt={savedAt} />
            <Button onClick={() => setHistoryOpen((open) => !open)}>History</Button>
          </div>
        </header>
        <iframe
          ref={iframeRef}
          title="Diagram editor"
          src="/drawio/editor.html"
          sandbox="allow-scripts allow-same-origin allow-downloads allow-popups"
          className="min-h-0 w-full flex-1 border-0 bg-[#0b0b0d]"
        />
      </div>
      {historyOpen && (
        <HistoryPanel
          docId={docId}
          onClose={() => setHistoryOpen(false)}
          onRestore={restoreVersion}
        />
      )}
    </div>
  )
}
