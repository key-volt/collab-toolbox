import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import { forEachDiagnostic, lintGutter } from '@codemirror/lint'
import { EditorState, type Extension } from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'

import { usePresence } from '../../App'
import { HistoryPanel } from '../../components/HistoryPanel'
import { SaveState } from '../../components/SaveState'
import { TitleEditor } from '../../components/TitleEditor'
import { Button, Dialog, ErrorLine, Field, TextInput } from '../../components/ui'
import { api, apiText, getAccessToken, refreshSession } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { colorFor, isElected, peersFrom, RoomSession } from '../../lib/collab'
import { pushSnapshot, type ToolsInfo } from '../../lib/snapshots'
import { languageFor } from './languages'
import { formatPython, lintExtensionFor } from './lint'
import { baseName, conflictName, parentOf, pathError } from './paths'
import { SandboxPanel, type SandboxFile } from './SandboxPanel'

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
  access: 'read' | 'edit' | 'manage'
  pages: PageRow[]
}

interface FileEntry {
  id: string
  path: string
}

function filesOf(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>('files')
}

function pathsOf(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>('paths')
}

function foldersOf(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>('folders')
}

function listFiles(doc: Y.Doc): FileEntry[] {
  const entries: FileEntry[] = []
  pathsOf(doc).forEach((path, id) => {
    entries.push({ id, path })
  })
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

// Concurrent create/rename can converge with two files on one path. Deterministic
// repair: the younger id moves aside under a visible -conflict- name.
function healPathConflicts(doc: Y.Doc): void {
  const paths = pathsOf(doc)
  const byPath = new Map<string, string[]>()
  paths.forEach((path, id) => {
    const ids = byPath.get(path) ?? []
    ids.push(id)
    byPath.set(path, ids)
  })
  const renames: { id: string; path: string }[] = []
  for (const [path, ids] of byPath) {
    if (ids.length < 2) continue
    for (const id of ids.sort().slice(1)) {
      renames.push({ id, path: conflictName(path, id) })
    }
  }
  if (renames.length === 0) return
  doc.transact(() => {
    for (const rename of renames) paths.set(rename.id, rename.path)
  })
}

function buildSnapshotBody(doc: Y.Doc): string {
  const files = listFiles(doc).map((entry) => ({
    path: entry.path,
    // toJSON is Y.Text's typed accessor for the plain string content.
    text: filesOf(doc).get(entry.id)?.toJSON() ?? '',
  }))
  const filePaths = new Set(files.map((entry) => entry.path))
  const folders = [...new Set(foldersOf(doc).toArray())].filter(
    (folder) =>
      !filePaths.has(folder) && ![...filePaths].some((path) => path.startsWith(`${folder}/`)),
  )
  return JSON.stringify({ files, folders })
}

interface TreeRow {
  kind: 'file' | 'folder'
  path: string
  depth: number
  fileId?: string
}

function buildTree(entries: FileEntry[], extraFolders: string[]): TreeRow[] {
  const folderSet = new Set<string>()
  for (const entry of entries) {
    let parent = parentOf(entry.path)
    while (parent !== '' && !folderSet.has(parent)) {
      folderSet.add(parent)
      parent = parentOf(parent)
    }
  }
  for (const folder of extraFolders) {
    let current = folder
    while (current !== '' && !folderSet.has(current)) {
      folderSet.add(current)
      current = parentOf(current)
    }
  }
  const rows: TreeRow[] = [
    ...[...folderSet].map<TreeRow>((path) => ({ kind: 'folder', path, depth: 0 })),
    ...entries.map<TreeRow>((entry) => ({ kind: 'file', path: entry.path, depth: 0, fileId: entry.id })),
  ]
  // Folders sort before the files beside them; depth comes from the path itself.
  rows.sort((a, b) => {
    const aKey = `${parentOf(a.path)}/${a.kind === 'folder' ? '0' : '1'}${baseName(a.path)}`
    const bKey = `${parentOf(b.path)}/${b.kind === 'folder' ? '0' : '1'}${baseName(b.path)}`
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
  })
  const ordered: TreeRow[] = []
  const place = (parent: string, depth: number) => {
    for (const row of rows) {
      if (parentOf(row.path) !== parent) continue
      ordered.push({ ...row, depth })
      if (row.kind === 'folder') place(row.path, depth + 1)
    }
  }
  place('', 0)
  return ordered
}

function editorTheme(): Extension {
  return EditorView.theme(
    {
      '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--color-bg)' },
      '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      '.cm-gutters': {
        backgroundColor: 'var(--color-bg)',
        color: 'var(--color-muted)',
        border: 'none',
      },
      '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.04)' },
      '.cm-activeLineGutter': { backgroundColor: 'rgba(0,0,0,0.04)' },
      '&.cm-focused': { outline: 'none' },
      '.cm-ySelectionInfo': { fontFamily: 'var(--font-sans)', padding: '1px 4px' },
    },
    { dark: false },
  )
}

export function CodeEditor({ docId }: { docId: string }) {
  const { user } = useAuth()
  const { setPeers } = usePresence()
  const navigate = useNavigate()

  const [detail, setDetail] = useState<DocumentDetail | null>(null)
  const [connected, setConnected] = useState(false)
  const [denied, setDenied] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [autosaveSeconds, setAutosaveSeconds] = useState(10)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [extraFolders, setExtraFolders] = useState<string[]>([])
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [filePresence, setFilePresence] = useState<Record<string, string[]>>({})
  const [dialog, setDialog] = useState<
    | { kind: 'new-file' | 'new-folder'; prefill: string }
    | { kind: 'rename'; fileId: string; path: string }
    | { kind: 'delete'; fileId: string; path: string }
    | null
  >(null)
  // 'static' is the reader-facing fallback: nobody has seeded the live room, so the
  // last save is shown from the stored files instead of an empty project.
  const [mode, setMode] = useState<'live' | 'static'>('live')

  const sessionRef = useRef<RoomSession | null>(null)
  const editorHostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const undoManagersRef = useRef(new Map<string, Y.UndoManager>())

  useEffect(() => {
    api<DocumentDetail>(`/api/documents/${docId}`).then(setDetail).catch(() => setDenied(true))
    api<ToolsInfo>('/api/tools')
      .then((info) => setAutosaveSeconds(info.autosave_seconds))
      .catch(() => undefined)
  }, [docId])

  // The room: connect once per document, seed it when we are the elected first client,
  // and mirror the file list plus presence into React state. Readers join the same
  // room but never write; a reader facing a never-seeded room switches to a static
  // local copy of the last save instead.
  const access = detail?.access ?? null
  useEffect(() => {
    if (access === null) return
    const canEdit = access !== 'read'
    let cancelled = false

    const session = new RoomSession(
      'code',
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

    const syncEntries = () => {
      const listed = listFiles(session.doc)
      setEntries(listed)
      setExtraFolders([...new Set(foldersOf(session.doc).toArray())])
      setActiveFileId((current) =>
        current !== null && listed.some((entry) => entry.id === current)
          ? current
          : (listed[0]?.id ?? null),
      )
    }
    filesOf(session.doc).observe(syncEntries)
    pathsOf(session.doc).observe(syncEntries)
    foldersOf(session.doc).observe(syncEntries)

    const seedFromStored = async () => {
      const fresh = await api<DocumentDetail>(`/api/documents/${docId}`)
      const contents = await Promise.all(
        fresh.pages.map((page) =>
          apiText(`/api/documents/${docId}/files/${page.filename}`).catch(() => ''),
        ),
      )
      if (cancelled) return
      session.doc.transact(() => {
        fresh.pages.forEach((page, index) => {
          const id = crypto.randomUUID()
          const text = new Y.Text()
          text.insert(0, contents[index])
          filesOf(session.doc).set(id, text)
          pathsOf(session.doc).set(id, page.filename)
        })
      })
    }

    async function seed() {
      const awareness = session.awareness
      if (awareness === null) return
      if (pathsOf(session.doc).size > 0) {
        syncEntries()
        return
      }
      // Let awareness settle so simultaneous first joiners agree on the elected client
      // before either writes anything.
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (cancelled || pathsOf(session.doc).size > 0 || !isElected(awareness)) return
      await seedFromStored()
    }

    async function readerProbe() {
      // A reader must never seed the shared room — the server would drop the writes.
      // If nobody has seeded it, show the stored files statically instead.
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (cancelled) return
      if (pathsOf(session.doc).size === 0) setMode('static')
    }

    if (mode === 'static') {
      // A local, never-connected copy: same document shape, no provider, no awareness.
      void seedFromStored()
      syncEntries()
    } else {
      session.connect()
      const awareness = session.awareness
      if (awareness !== null && user !== null) {
        const color = colorFor(user.id)
        awareness.setLocalStateField('user', {
          name: user.username,
          color,
          colorLight: color.replace(')', ' / 0.25)'),
          canEdit,
        })
        const publishPresence = () => {
          setPeers(peersFrom(awareness))
          const perFile: Record<string, string[]> = {}
          for (const [clientId, state] of awareness.getStates()) {
            if (clientId === awareness.clientID) continue
            const typed = state as { codeFile?: string; user?: { color?: string } }
            if (typeof typed.codeFile !== 'string') continue
            const colors = perFile[typed.codeFile] ?? []
            colors.push(typed.user?.color ?? '#6b6156')
            perFile[typed.codeFile] = colors
          }
          setFilePresence(perFile)
        }
        awareness.on('change', publishPresence)
        publishPresence()
      }
      syncEntries()
    }

    const undoManagers = undoManagersRef.current
    return () => {
      cancelled = true
      const finalAwareness = session.awareness
      if (
        canEdit &&
        finalAwareness !== null &&
        isElected(finalAwareness) &&
        pathsOf(session.doc).size > 0
      ) {
        healPathConflicts(session.doc)
        void pushSnapshot('code', docId, buildSnapshotBody(session.doc), 'application/json', true)
      }
      viewRef.current?.destroy()
      viewRef.current = null
      undoManagers.clear()
      setPeers([])
      session.destroy()
      sessionRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one room per document, mode and access
  }, [docId, access, mode])

  // Bind the editor to the active file. Presence of the file is the dependency that
  // matters — unrelated tree changes must not rebuild the view mid-typing.
  const activeExists = entries.some((entry) => entry.id === activeFileId)
  const activePath = entries.find((entry) => entry.id === activeFileId)?.path ?? null
  const activeIsPython = activePath?.endsWith('.py') === true
  useEffect(() => {
    const session = sessionRef.current
    const host = editorHostRef.current
    if (session === null || host === null || activeFileId === null || !activeExists) return
    // Null awareness is the static reader copy: same editor, no collaboration layer.
    const awareness = session.awareness
    const text = filesOf(session.doc).get(activeFileId)
    const path = pathsOf(session.doc).get(activeFileId)
    if (text === undefined || path === undefined) return
    const readOnly = access === 'read'

    let undoManager = undoManagersRef.current.get(activeFileId)
    if (undoManager === undefined) {
      undoManager = new Y.UndoManager(text)
      undoManagersRef.current.set(activeFileId, undoManager)
    }
    awareness?.setLocalStateField('codeFile', activeFileId)

    const language = languageFor(path)
    const state = EditorState.create({
      doc: text.toJSON(),
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...yUndoManagerKeymap, ...closeBracketsKeymap, ...defaultKeymap, indentWithTab]),
        language.fourSpaceIndent === true ? indentUnit.of('    ') : [],
        language.extension,
        lintExtensionFor(language.lint, path),
        lintGutter(),
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
        awareness === null ? [] : [yCollab(text, awareness, { undoManager })],
        editorTheme(),
      ],
    })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view

    // Deterministic handles for the browser suite; they carry no secrets.
    const debugWindow = window as unknown as { __codeDebug?: unknown }
    debugWindow.__codeDebug = {
      fileCount: () => pathsOf(session.doc).size,
      paths: () => listFiles(session.doc).map((entry) => entry.path),
      activeFile: () => pathsOf(session.doc).get(activeFileId),
      setActiveFile: (wanted: string) => {
        const entry = listFiles(session.doc).find((candidate) => candidate.path === wanted)
        if (entry !== undefined) setActiveFileId(entry.id)
      },
      docText: (wanted: string) => {
        const entry = listFiles(session.doc).find((candidate) => candidate.path === wanted)
        return entry === undefined ? null : filesOf(session.doc).get(entry.id)?.toJSON()
      },
      editorText: () => view.state.doc.toString(),
      lintCount: () => {
        let count = 0
        forEachDiagnostic(view.state, () => {
          count += 1
        })
        return count
      },
      undo: () => undoManager.undo(),
      dropConnection: () => {
        const socket = (sessionRef.current?.provider as unknown as { ws?: WebSocket } | null)?.ws
        socket?.close()
      },
    }

    return () => {
      view.destroy()
      if (viewRef.current === view) viewRef.current = null
    }
  }, [activeFileId, activeExists, access, mode])

  // The elected client persists the project on the autosave cadence. Readers never
  // push — the election excludes them, and the server would refuse the push anyway.
  useEffect(() => {
    if (access === 'read' || access === null) return
    const timer = setInterval(() => {
      const session = sessionRef.current
      const awareness = session?.awareness ?? null
      if (session === null || awareness === null || !isElected(awareness)) return
      if (pathsOf(session.doc).size === 0) return
      healPathConflicts(session.doc)
      void pushSnapshot('code', docId, buildSnapshotBody(session.doc), 'application/json')
        .then(() => setSavedAt(Date.now()))
        .catch(() => undefined)
    }, autosaveSeconds * 1000)
    return () => clearInterval(timer)
  }, [autosaveSeconds, docId, access])

  const restoreVersion = useCallback((filename: string, content: string) => {
    const session = sessionRef.current
    if (session === null) return
    const entry = listFiles(session.doc).find((candidate) => candidate.path === filename)
    session.doc.transact(() => {
      if (entry !== undefined) {
        const text = filesOf(session.doc).get(entry.id)
        if (text === undefined) return
        text.delete(0, text.length)
        text.insert(0, content)
      } else {
        // Restoring a deleted file brings it back — that is the undelete path.
        const id = crypto.randomUUID()
        const text = new Y.Text()
        text.insert(0, content)
        filesOf(session.doc).set(id, text)
        pathsOf(session.doc).set(id, filename)
      }
    })
  }, [])

  const createFile = (path: string): string | null => {
    const session = sessionRef.current
    if (session === null) return 'not connected'
    const problem = pathError(path)
    if (problem !== null) return problem
    if (listFiles(session.doc).some((entry) => entry.path === path)) return 'that name is taken'
    const id = crypto.randomUUID()
    session.doc.transact(() => {
      filesOf(session.doc).set(id, new Y.Text())
      pathsOf(session.doc).set(id, path)
    })
    setActiveFileId(id)
    return null
  }

  const createFolder = (path: string): string | null => {
    const session = sessionRef.current
    if (session === null) return 'not connected'
    const problem = pathError(path, { folder: true })
    if (problem !== null) return problem
    if (foldersOf(session.doc).toArray().includes(path)) return 'that folder already exists'
    foldersOf(session.doc).push([path])
    return null
  }

  const renameFile = (fileId: string, nextPath: string): string | null => {
    const session = sessionRef.current
    if (session === null) return 'not connected'
    const problem = pathError(nextPath)
    if (problem !== null) return problem
    const clash = listFiles(session.doc).some(
      (entry) => entry.path === nextPath && entry.id !== fileId,
    )
    if (clash) return 'that name is taken'
    pathsOf(session.doc).set(fileId, nextPath)
    return null
  }

  const deleteFile = (fileId: string) => {
    const session = sessionRef.current
    if (session === null) return
    session.doc.transact(() => {
      filesOf(session.doc).delete(fileId)
      pathsOf(session.doc).delete(fileId)
    })
    undoManagersRef.current.delete(fileId)
  }

  const formatActiveFile = () => {
    const view = viewRef.current
    if (view === null || !activeIsPython) return
    const before = view.state.doc.toString()
    void formatPython(before).then((formatted) => {
      const current = viewRef.current
      if (formatted === null || current !== view) return
      if (view.state.doc.toString() !== before || formatted === before) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted } })
    })
  }

  const sandboxFiles = useCallback((): SandboxFile[] => {
    const session = sessionRef.current
    if (session === null) return []
    return listFiles(session.doc).map((entry) => ({
      path: entry.path,
      text: filesOf(session.doc).get(entry.id)?.toJSON() ?? '',
    }))
  }, [])

  if (denied) {
    return (
      <div className="text-muted flex h-full flex-col items-center justify-center gap-3 text-sm">
        <p>This project is not available.</p>
        <Button onClick={() => void navigate('/')}>Back to documents</Button>
      </div>
    )
  }

  const canMutate = access !== null && access !== 'read'
  const canManage = access === 'manage'
  const tree = buildTree(entries, extraFolders)
  const visibleRows = tree.filter((row) => {
    let parent = parentOf(row.path)
    while (parent !== '') {
      if (collapsed.has(parent)) return false
      parent = parentOf(parent)
    }
    return true
  })

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border">
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
          <span className="text-muted text-xs">Files</span>
          {canMutate && (
            <span className="flex gap-1">
              <button
                type="button"
                aria-label="New file"
                title="New file"
                className="text-muted hover:text-text rounded px-1.5 text-sm"
                onClick={() => setDialog({ kind: 'new-file', prefill: folderPrefill(activePath) })}
              >
                +
              </button>
              <button
                type="button"
                aria-label="New folder"
                title="New folder"
                className="text-muted hover:text-text rounded px-1.5 text-sm"
                onClick={() => setDialog({ kind: 'new-folder', prefill: folderPrefill(activePath) })}
              >
                ⊞
              </button>
            </span>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5" data-testid="file-tree">
          {visibleRows.map((row) =>
            row.kind === 'folder' ? (
              <button
                key={`folder:${row.path}`}
                type="button"
                className="text-muted hover:text-text block w-full truncate rounded px-2 py-1 text-left text-xs"
                style={{ paddingLeft: `${String(8 + row.depth * 12)}px` }}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current)
                    if (next.has(row.path)) next.delete(row.path)
                    else next.add(row.path)
                    return next
                  })
                }
              >
                {collapsed.has(row.path) ? '▸' : '▾'} {baseName(row.path)}
              </button>
            ) : (
              <div
                key={row.fileId}
                className={`group flex items-center rounded ${
                  row.fileId === activeFileId ? 'bg-raised' : 'hover:bg-raised/50'
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate px-2 py-1 text-left text-xs"
                  style={{ paddingLeft: `${String(8 + row.depth * 12)}px` }}
                  onClick={() => row.fileId !== undefined && setActiveFileId(row.fileId)}
                >
                  {baseName(row.path)}
                </button>
                {(filePresence[row.fileId ?? ''] ?? []).slice(0, 3).map((color, index) => (
                  <span
                    key={index}
                    aria-hidden
                    className="mr-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                ))}
                {canMutate && (
                  <>
                    <button
                      type="button"
                      aria-label={`Rename ${row.path}`}
                      className="text-muted hover:text-text hidden px-1 text-xs group-hover:block"
                      onClick={() =>
                        row.fileId !== undefined &&
                        setDialog({ kind: 'rename', fileId: row.fileId, path: row.path })
                      }
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${row.path}`}
                      className="text-muted hover:text-danger hidden px-1 text-xs group-hover:block"
                      onClick={() =>
                        row.fileId !== undefined &&
                        setDialog({ kind: 'delete', fileId: row.fileId, path: row.path })
                      }
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            ),
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
          <Link to="/t/code" className="text-muted hover:text-text text-sm">
            ←
          </Link>
          {detail !== null &&
            (canManage ? (
              <TitleEditor key={detail.title} docId={docId} title={detail.title} />
            ) : (
              <span className="truncate text-sm font-medium">{detail.title}</span>
            ))}
          <span className="text-muted truncate text-xs" data-testid="active-path">
            {activePath ?? ''}
          </span>
          <div className="ml-auto flex items-center gap-3">
            {canMutate && <SaveState connected={connected} lastSavedAt={savedAt} />}
            {activeIsPython && canMutate && <Button onClick={formatActiveFile}>Format</Button>}
            <Button onClick={() => setTerminalOpen((open) => !open)}>Terminal</Button>
            <Button onClick={() => setHistoryOpen((open) => !open)}>History</Button>
          </div>
        </header>
        {mode === 'static' && (
          <div className="text-muted flex shrink-0 items-center gap-3 border-b border-border bg-raised px-3 py-1.5 text-xs">
            <span>Static view of the last save — reload to check for live editors.</span>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        )}
        <div ref={editorHostRef} className="min-h-0 flex-1 overflow-hidden" />
        {terminalOpen && (
          <SandboxPanel
            getFiles={sandboxFiles}
            activePath={activePath}
            onClose={() => setTerminalOpen(false)}
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

      {dialog !== null && (dialog.kind === 'new-file' || dialog.kind === 'new-folder') && (
        <PathDialog
          title={dialog.kind === 'new-file' ? 'New file' : 'New folder'}
          label={
            dialog.kind === 'new-file'
              ? 'Path, folders included (for example src/main.py)'
              : 'Folder path (for example src/lib)'
          }
          initial={dialog.prefill}
          submitLabel="Create"
          onSubmit={(path) => (dialog.kind === 'new-file' ? createFile(path) : createFolder(path))}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog !== null && dialog.kind === 'rename' && (
        <PathDialog
          title="Rename file"
          label="New path — changing folders moves the file"
          initial={dialog.path}
          submitLabel="Rename"
          onSubmit={(path) => renameFile(dialog.fileId, path)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog !== null && dialog.kind === 'delete' && (
        <Dialog open onOpenChange={(next) => !next && setDialog(null)} title="Delete file">
          <div className="space-y-4">
            <p className="text-muted text-sm">
              Delete <span className="text-text">{dialog.path}</span>? Its saved versions stay in
              History, so it can be restored from there.
            </p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  deleteFile(dialog.fileId)
                  setDialog(null)
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}

function folderPrefill(activePath: string | null): string {
  if (activePath === null) return ''
  const parent = parentOf(activePath)
  return parent === '' ? '' : `${parent}/`
}

function PathDialog({
  title,
  label,
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string
  label: string
  initial: string
  submitLabel: string
  onSubmit: (path: string) => string | null
  onClose: () => void
}) {
  // Mounted only while open, so every opening starts from a clean slate.
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const problem = onSubmit(value.trim())
    if (problem !== null) setError(problem)
    else onClose()
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()} title={title}>
      <div className="space-y-4">
        <Field label={label}>
          <TextInput
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
        </Field>
        <ErrorLine message={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={value.trim() === ''} onClick={submit}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
