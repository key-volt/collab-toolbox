import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { BinaryFileData, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { generateNKeysBetween } from 'fractional-indexing'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import * as Y from 'yjs'

import { usePresence } from '../../App'
import { HistoryPanel } from '../../components/HistoryPanel'
import { SaveState } from '../../components/SaveState'
import { TitleEditor } from '../../components/TitleEditor'
import { Button, Dialog, Field, TextInput } from '../../components/ui'
import { api, apiBlob, getAccessToken, refreshSession } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { colorFor, isElected, peersFrom, RoomSession } from '../../lib/collab'
import { pushSnapshot, type ToolsInfo } from '../../lib/snapshots'
import {
  ExcalidrawBinding,
  yjsToExcalidraw,
  type AssetStore,
  type StoredAsset,
} from '../../vendor/y-excalidraw'

interface PageRow {
  id: string
  ordinal: number
  title: string
  filename: string
  page_index: number | null
}

interface DocumentDetail {
  id: string
  tool: string
  title: string
  created_at: string
  pages: PageRow[]
}

interface PageContent {
  elements?: unknown[]
  collabUploads?: Record<string, { uploadId: string; mimeType: string }>
}

const EMPTY_CONTENT: PageContent = { elements: [], collabUploads: {} }

function pagesMapOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>('pages')
}

function orderOf(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>('order')
}

function elementsOf(page: Y.Map<unknown>): Y.Array<Y.Map<unknown>> {
  return page.get('elements') as Y.Array<Y.Map<unknown>>
}

function assetsOf(page: Y.Map<unknown>): Y.Map<unknown> {
  return page.get('assets') as Y.Map<unknown>
}

function wrapElements(elements: unknown[]): Y.Map<unknown>[] {
  const keys = generateNKeysBetween(null, null, elements.length)
  return elements.map(
    (element, index) => new Y.Map<unknown>(Object.entries({ pos: keys[index], el: element })),
  )
}

function buildPage(title: string, content: PageContent): Y.Map<unknown> {
  const page = new Y.Map<unknown>()
  page.set('title', title)
  const elements = new Y.Array<Y.Map<unknown>>()
  elements.push(wrapElements(content.elements ?? []))
  page.set('elements', elements)
  const assets = new Y.Map<unknown>()
  for (const [fileId, ref] of Object.entries(content.collabUploads ?? {})) {
    assets.set(fileId, { id: fileId, mimeType: ref.mimeType, uploadId: ref.uploadId })
  }
  page.set('assets', assets)
  return page
}

function parsePageContent(raw: string): PageContent {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed
    }
  } catch {
    // fall through to an empty page
  }
  return EMPTY_CONTENT
}

function buildSnapshotBody(doc: Y.Doc): string {
  const pagesMap = pagesMapOf(doc)
  const pages = orderOf(doc)
    .toArray()
    .flatMap((pageId) => {
      const page = pagesMap.get(pageId)
      if (page === undefined) return []
      const collabUploads: Record<string, { uploadId: string; mimeType: string }> = {}
      assetsOf(page).forEach((value, key) => {
        const stored = value as Partial<StoredAsset> | null
        if (stored !== null && typeof stored.uploadId === 'string') {
          collabUploads[key] = {
            uploadId: stored.uploadId,
            mimeType: stored.mimeType ?? 'application/octet-stream',
          }
        }
      })
      return [
        {
          id: pageId,
          title: (page.get('title') as string | undefined) ?? 'Page',
          content: {
            type: 'excalidraw',
            version: 2,
            elements: yjsToExcalidraw(elementsOf(page)),
            appState: {},
            files: {},
            collabUploads,
          },
        },
      ]
    })
  return JSON.stringify({ pages })
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta = '', payload = ''] = dataUrl.split(',', 2)
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? 'application/octet-stream'
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: mime })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('could not read the file'))
    reader.readAsDataURL(blob)
  })
}

export function PaintEditor({ docId }: { docId: string }) {
  const { user } = useAuth()
  const { setPeers } = usePresence()
  const navigate = useNavigate()

  const [detail, setDetail] = useState<DocumentDetail | null>(null)
  const [connected, setConnected] = useState(false)
  const [denied, setDenied] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [orderIds, setOrderIds] = useState<string[]>([])
  const [pageTitles, setPageTitles] = useState<Record<string, string>>({})
  const [currentPageId, setCurrentPageId] = useState<string | null>(null)
  const [renamingPage, setRenamingPage] = useState<string | null>(null)
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null)
  const [autosaveSeconds, setAutosaveSeconds] = useState(10)

  const sessionRef = useRef<RoomSession | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bindingRef = useRef<ExcalidrawBinding | null>(null)
  const undoManagersRef = useRef(new Map<string, Y.UndoManager>())

  useEffect(() => {
    api<DocumentDetail>(`/api/documents/${docId}`).then(setDetail).catch(() => setDenied(true))
    api<ToolsInfo>('/api/tools')
      .then((info) => setAutosaveSeconds(info.autosave_seconds))
      .catch(() => undefined)
  }, [docId])

  const assetStore = useMemo<AssetStore>(
    () => ({
      store: async (file) => {
        const form = new FormData()
        form.append('file', dataUrlToBlob(file.dataURL), file.id)
        form.append('document_id', docId)
        const uploaded = await api<{ id: string }>('/api/files', { method: 'POST', body: form })
        return { id: file.id, mimeType: file.mimeType, uploadId: uploaded.id }
      },
      load: async (asset) => {
        const blob = await apiBlob(`/api/files/${asset.uploadId}`)
        const dataURL = await blobToDataUrl(blob)
        return {
          id: asset.id,
          mimeType: asset.mimeType,
          dataURL,
          created: Date.now(),
        } as unknown as BinaryFileData
      },
    }),
    [docId],
  )

  // The room: connect once per document, seed it when we are the elected first client,
  // keep the order list and the presence roster mirrored into React state.
  useEffect(() => {
    const session = new RoomSession(
      'paint',
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
    const order = orderOf(session.doc)
    const syncOrder = () => {
      const ids = order.toArray()
      const titles: Record<string, string> = {}
      for (const id of ids) {
        const title = pagesMapOf(session.doc).get(id)?.get('title')
        titles[id] = typeof title === 'string' ? title : 'Page'
      }
      setOrderIds(ids)
      setPageTitles(titles)
      setCurrentPageId((current) =>
        current !== null && ids.includes(current) ? current : (ids[0] ?? null),
      )
    }
    order.observe(syncOrder)
    // Deep-observe the pages map too, so a remote page rename re-renders the tabs.
    pagesMapOf(session.doc).observeDeep(syncOrder)

    async function seed() {
      const awareness = session.awareness
      if (awareness === null) return
      if (order.length > 0) {
        syncOrder()
        return
      }
      // Give awareness a moment to propagate so two simultaneous joiners agree on who
      // the elected client is before either writes anything.
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (order.length > 0 || !isElected(awareness)) return
      const fresh = await api<DocumentDetail>(`/api/documents/${docId}`)
      const contents = await Promise.all(
        fresh.pages.map((page) =>
          api<unknown>(`/api/documents/${docId}/files/${page.filename}`).catch(() => null),
        ),
      )
      session.doc.transact(() => {
        fresh.pages.forEach((page, index) => {
          const raw: unknown = contents[index]
          const content =
            typeof raw === 'object' && raw !== null ? (raw as PageContent) : EMPTY_CONTENT
          pagesMapOf(session.doc).set(page.id, buildPage(page.title, content))
          order.push([page.id])
        })
      })
    }

    session.connect()
    const awareness = session.awareness
    if (awareness !== null && user !== null) {
      awareness.setLocalStateField('user', { name: user.username, color: colorFor(user.id) })
      const publishPeers = () => setPeers(peersFrom(awareness))
      awareness.on('change', publishPeers)
      publishPeers()
    }
    syncOrder()

    const undoManagers = undoManagersRef.current
    return () => {
      const finalAwareness = session.awareness
      if (finalAwareness !== null && isElected(finalAwareness) && orderOf(session.doc).length > 0) {
        void pushSnapshot('paint', docId, buildSnapshotBody(session.doc), 'application/json', true)
      }
      bindingRef.current?.destroy()
      bindingRef.current = null
      undoManagers.clear()
      setPeers([])
      session.destroy()
      sessionRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one room per document
  }, [docId])

  // Bind the canvas to the current page's element list.
  useEffect(() => {
    const session = sessionRef.current
    if (session === null || excalidrawAPI === null || currentPageId === null) return
    const page = pagesMapOf(session.doc).get(currentPageId)
    const awareness = session.awareness
    const dom = containerRef.current
    if (page === undefined || awareness === null || dom === null) return

    let undoManager = undoManagersRef.current.get(currentPageId)
    if (undoManager === undefined) {
      undoManager = new Y.UndoManager(elementsOf(page), { trackedOrigins: new Set() })
      undoManagersRef.current.set(currentPageId, undoManager)
    }
    const pageUndoManager = undoManager
    awareness.setLocalStateField('pageId', currentPageId)
    const binding = new ExcalidrawBinding(
      elementsOf(page),
      assetsOf(page),
      excalidrawAPI,
      awareness,
      { excalidrawDom: dom, undoManager: pageUndoManager },
      assetStore,
    )
    bindingRef.current = binding
    // A high-water mark of how many elements the canvas has ever held while this page
    // was bound, deleted ones included. The browser suite reads it to tell "the drag
    // never created anything" apart from "something created it and something else
    // removed it" in a single report.
    let everSceneCount = excalidrawAPI.getSceneElementsIncludingDeleted().length
    const stopCountingScene = excalidrawAPI.onChange(() => {
      everSceneCount = Math.max(
        everSceneCount,
        excalidrawAPI.getSceneElementsIncludingDeleted().length,
      )
    })
    // Deterministic handles for the browser test suite; they carry no secrets. Tool
    // selection and undo go through the imperative APIs because keyboard shortcuts
    // depend on where focus happens to be, which a test must not.
    const debugWindow = window as unknown as { __paintDebug?: unknown }
    debugWindow.__paintDebug = {
      elementCount: () => elementsOf(page).length,
      sceneCount: () => excalidrawAPI.getSceneElements().length,
      sceneCountAll: () => excalidrawAPI.getSceneElementsIncludingDeleted().length,
      everSceneCount: () => everSceneCount,
      activeTool: () => (excalidrawAPI.getAppState() as { activeTool: { type: string } }).activeTool.type,
      collaboratorCount: () => bindingRef.current?.collaborators.size ?? 0,
      setTool: (tool: string) => {
        excalidrawAPI.setActiveTool({ type: tool } as never)
      },
      undo: () => {
        pageUndoManager.undo()
      },
      dropConnection: () => {
        const socket = (sessionRef.current?.provider as unknown as { ws?: WebSocket } | null)?.ws
        socket?.close()
      },
    }
    return () => {
      stopCountingScene()
      binding.destroy()
      bindingRef.current = null
    }
  }, [excalidrawAPI, currentPageId, orderIds.length, assetStore])

  // The elected client persists the document on the autosave cadence.
  useEffect(() => {
    const timer = setInterval(() => {
      const session = sessionRef.current
      const awareness = session?.awareness ?? null
      if (session === null || awareness === null || !isElected(awareness)) return
      if (orderOf(session.doc).length === 0) return
      void pushSnapshot('paint', docId, buildSnapshotBody(session.doc), 'application/json')
        .then(() => setSavedAt(Date.now()))
        .catch(() => undefined)
    }, autosaveSeconds * 1000)
    return () => clearInterval(timer)
  }, [autosaveSeconds, docId])

  const restoreVersion = useCallback(
    (filename: string, content: string) => {
      const session = sessionRef.current
      if (session === null) return
      const match = /^page-(\d+)\.excalidraw$/.exec(filename)
      if (match === null) throw new Error('unknown version file')
      const ordinal = Number(match[1])
      const pageId = orderOf(session.doc).toArray().at(ordinal - 1)
      if (pageId === undefined) throw new Error('that page no longer exists')
      const page = pagesMapOf(session.doc).get(pageId)
      if (page === undefined) throw new Error('that page no longer exists')
      const parsed = parsePageContent(content)
      session.doc.transact(() => {
        const elements = elementsOf(page)
        elements.delete(0, elements.length)
        elements.push(wrapElements(parsed.elements ?? []))
        const assets = assetsOf(page)
        for (const key of [...assets.keys()]) assets.delete(key)
        for (const [fileId, ref] of Object.entries(parsed.collabUploads ?? {})) {
          assets.set(fileId, { id: fileId, mimeType: ref.mimeType, uploadId: ref.uploadId })
        }
      })
    },
    [],
  )

  const addPage = () => {
    const session = sessionRef.current
    if (session === null) return
    const id = crypto.randomUUID()
    session.doc.transact(() => {
      pagesMapOf(session.doc).set(id, buildPage(`Page ${String(orderIds.length + 1)}`, EMPTY_CONTENT))
      orderOf(session.doc).push([id])
    })
    setCurrentPageId(id)
  }

  const removePage = (pageId: string) => {
    const session = sessionRef.current
    if (session === null || orderIds.length <= 1) return
    session.doc.transact(() => {
      const order = orderOf(session.doc)
      const index = order.toArray().indexOf(pageId)
      if (index !== -1) order.delete(index, 1)
      pagesMapOf(session.doc).delete(pageId)
    })
    undoManagersRef.current.delete(pageId)
  }

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
          <Link to="/t/paint" className="text-muted hover:text-text text-sm">
            ←
          </Link>
          {detail !== null && <TitleEditor key={detail.title} docId={docId} title={detail.title} />}
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {orderIds.map((pageId) => (
              <span key={pageId} className="flex items-center">
                <button
                  type="button"
                  onClick={() => setCurrentPageId(pageId)}
                  onDoubleClick={() => setRenamingPage(pageId)}
                  className={`rounded-md px-2.5 py-1 text-xs whitespace-nowrap transition ${
                    currentPageId === pageId
                      ? 'bg-raised text-text'
                      : 'text-muted hover:text-text'
                  }`}
                >
                  {pageTitles[pageId]}
                </button>
                {user?.is_admin === true && orderIds.length > 1 && currentPageId === pageId && (
                  <button
                    type="button"
                    aria-label="Delete page"
                    className="text-muted hover:text-danger px-1 text-xs"
                    onClick={() => removePage(pageId)}
                  >
                    ✕
                  </button>
                )}
              </span>
            ))}
            <button
              type="button"
              aria-label="Add page"
              onClick={addPage}
              className="text-muted hover:text-text px-2 text-sm"
            >
              +
            </button>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <SaveState connected={connected} lastSavedAt={savedAt} />
            <Button onClick={() => setHistoryOpen((open) => !open)}>History</Button>
          </div>
        </header>
        <div ref={containerRef} className="min-h-0 flex-1">
          <Excalidraw
            theme="dark"
            excalidrawAPI={(apiInstance) => setExcalidrawAPI(apiInstance)}
            onPointerUpdate={(payload) => bindingRef.current?.onPointerUpdate(payload)}
          />
        </div>
      </div>
      {historyOpen && (
        <HistoryPanel
          docId={docId}
          onClose={() => setHistoryOpen(false)}
          onRestore={restoreVersion}
        />
      )}
      {renamingPage !== null && (
        <RenamePageDialog
          initial={pageTitles[renamingPage]}
          onClose={() => setRenamingPage(null)}
          onRename={(next) => {
            const session = sessionRef.current
            if (session !== null) {
              pagesMapOf(session.doc).get(renamingPage)?.set('title', next)
            }
            setRenamingPage(null)
          }}
        />
      )}
    </div>
  )
}

function RenamePageDialog({
  initial,
  onClose,
  onRename,
}: {
  initial: string
  onClose: () => void
  onRename: (next: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()} title="Rename page">
      <div className="space-y-4">
        <Field label="Page name">
          <TextInput autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={value.trim() === ''} onClick={() => onRename(value.trim())}>
            Rename
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
