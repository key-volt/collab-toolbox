// The child half of the diagram editor. This page is served from /drawio/ beside the
// pinned draw.io assets, boots the editor through its internal API, and keeps its local
// Y.Doc in step with the parent shell over the patched postMessage bridge. It talks to
// nothing else: no network, no tokens — the parent owns the connection.

import * as Y from 'yjs'

import { Binding, ydoc2xml } from './vendor/y-mxgraph'
import { createIframeBridgeProvider } from './vendor/y-mxgraph/iframe-bridge'
import type { DrawioFile, DrawioUi } from './vendor/y-mxgraph/types/drawio'

const DRAWIO_BASE = '/drawio/'

// The parent opens this page with ?readonly=1 for users who hold read access only.
// The shared document still syncs in (the server enforces the write side); the graph
// simply refuses local interaction.
const READ_ONLY = new URLSearchParams(window.location.search).get('readonly') === '1'

interface DrawioAppUi extends DrawioUi {
  refresh(): void
}

interface DrawioAppConstructor {
  new (editor: unknown, container: HTMLElement): unknown
  main(onReady: (ui: DrawioAppUi) => void, createUi: () => unknown): void
}

type DrawioEditorConstructor = new (
  chromeless: boolean,
  themes: unknown,
  model: unknown,
  graph: unknown,
  editable: boolean,
) => unknown

interface DrawioWindow {
  App?: DrawioAppConstructor
  Editor?: DrawioEditorConstructor
  mxIsElectron?: boolean
  mxLoadStylesheets?: boolean
  mxBasePath?: string
  mxImageBasePath?: string
  RESOURCES_PATH?: string
  RESOURCE_BASE?: string
  STENCIL_PATH?: string
  SHAPES_PATH?: string
  IMAGE_PATH?: string
  STYLE_PATH?: string
  PLUGINS_BASE_PATH?: string
  urlParams?: Record<string, string>
}

const drawioWindow = window as unknown as DrawioWindow

// draw.io's own index.html defines a global script-loader helper that app.min.js calls
// mid-boot to pull in its extra bundles (shapes, stencils, extensions). Serving the
// editor from our own page means providing it ourselves; relative paths resolve against
// the pinned assets beside this page.
type ScriptLoader = (
  src: string,
  onLoad?: () => void,
  id?: string,
  dataAppKey?: string,
  noWrite?: boolean,
  onError?: (message: string, error: unknown) => void,
) => void

function installScriptLoader(): void {
  const loader: ScriptLoader = (src, onLoad, id, _dataAppKey, _noWrite, onError) => {
    const resolved =
      src.startsWith('http') || src.startsWith('/') ? src : `${DRAWIO_BASE}${src}`
    const script = document.createElement('script')
    script.type = 'text/javascript'
    script.src = resolved
    if (id !== undefined) script.id = id
    if (onLoad !== undefined) {
      script.onload = () => onLoad()
    }
    if (onError !== undefined) {
      script.onerror = () => onError(`failed to load ${resolved}`, undefined)
    }
    document.head.appendChild(script)
  }
  ;(window as unknown as { mxscript?: ScriptLoader }).mxscript = loader
}

function configure(): void {
  installScriptLoader()
  // Everything here must be set before app.min.js runs. mxIsElectron off keeps draw.io
  // away from Node APIs; mxLoadStylesheets off stops it injecting CSS via
  // document.write — the two stylesheets are linked below instead.
  drawioWindow.mxIsElectron = false
  drawioWindow.mxLoadStylesheets = false
  drawioWindow.mxBasePath = `${DRAWIO_BASE}mxgraph`
  drawioWindow.mxImageBasePath = `${DRAWIO_BASE}mxgraph/images`
  drawioWindow.RESOURCES_PATH = `${DRAWIO_BASE}resources`
  drawioWindow.RESOURCE_BASE = `${DRAWIO_BASE}resources/dia`
  drawioWindow.STENCIL_PATH = `${DRAWIO_BASE}stencils`
  drawioWindow.SHAPES_PATH = `${DRAWIO_BASE}shapes`
  drawioWindow.IMAGE_PATH = `${DRAWIO_BASE}images`
  drawioWindow.STYLE_PATH = `${DRAWIO_BASE}styles`
  drawioWindow.PLUGINS_BASE_PATH = DRAWIO_BASE
  // stealth stops draw.io fetching fonts and other resources from third parties —
  // nothing leaves this host at runtime. demo makes it create a blank local file
  // instead of raising its "Save diagrams to:" storage dialog. The default (light)
  // UI matches the app theme.
  drawioWindow.urlParams = {
    math: '0',
    stealth: '1',
    demo: '1',
  }
}

function linkStylesheet(href: string): void {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  document.head.appendChild(link)
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(script)
  })
}

// Readiness is detected by polling for the App class, never by a fixed timeout — a
// timing guess that works on a fast machine is a race on a loaded one.
function waitForApp(): Promise<DrawioAppConstructor> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const poll = () => {
      const app = drawioWindow.App
      if (app !== undefined) {
        resolve(app)
        return
      }
      if (Date.now() - startedAt > 60_000) {
        reject(new Error('draw.io did not become ready'))
        return
      }
      setTimeout(poll, 100)
    }
    poll()
  })
}

// Every stage is published on the window and mirrored into the overlay, so a boot that
// stalls names the exact step it stalled on — in a screenshot, in a page snapshot, and
// to the browser test suite.
function setBootStage(stage: string): void {
  ;(window as unknown as { __editorBootStage?: string }).__editorBootStage = stage
  const loading = document.getElementById('editor-loading')
  if (loading !== null) loading.textContent = `loading the editor… (${stage})`
}

function showEditor(): void {
  document.getElementById('editor-loading')?.remove()
}

async function boot(): Promise<void> {
  setBootStage('configuring')
  configure()
  linkStylesheet(`${DRAWIO_BASE}mxgraph/css/common.css`)
  linkStylesheet(`${DRAWIO_BASE}styles/grapheditor.css`)
  setBootStage('loading the support script')
  try {
    await loadScript(`${DRAWIO_BASE}js/PreConfig.js`)
  } catch {
    // PreConfig is optional configuration; the app script carries the editor itself.
  }
  setBootStage('loading the editor script')
  await loadScript(`${DRAWIO_BASE}js/app.min.js`)
  setBootStage('waiting for the editor to define itself')
  const App = await waitForApp()

  setBootStage('connecting to the shell')
  const doc = new Y.Doc()
  const provider = createIframeBridgeProvider(doc, { consistencyCheckInterval: 30_000 })

  let booted = false
  const bindWhenReady = () => {
    if (booted) return
    booted = true
    setBootStage('starting the editor')
    App.main(
      (ui) => {
        setBootStage('opening the document')
        ui.refresh()
        window.dispatchEvent(new Event('resize'))
        const attach = (file: DrawioFile) => {
          if (!file.data) {
            file.data = Binding.generateFileTemplate('diagram-0')
          }
          const binding = new Binding(file, {
            doc,
            awareness: provider.awareness,
            undoManager: false,
            consistencyCheckInterval: 30_000,
            onDrift: (event) => {
              console.warn('[editor] document drift detected', event)
            },
          })
          provider.takeoverUndoManager(binding.file)
          const bindingUi = binding.file.getUi()
          bindingUi.editor.setModified(false)
          bindingUi.editor.setStatus('')
          binding.file.setModified(false)

          // Deterministic handles for the browser test suite; they carry no secrets.
          interface LooseGraph {
            insertVertex(
              parent: unknown,
              id: null,
              value: string,
              x: number,
              y: number,
              width: number,
              height: number,
            ): unknown
            getDefaultParent(): unknown
          }
          if (READ_ONLY) {
            const graph = bindingUi.editor.graph as unknown as {
              setEnabled(enabled: boolean): void
            }
            graph.setEnabled(false)
          }

          const debugWindow = window as unknown as { __editorDebug?: unknown }
          debugWindow.__editorDebug = {
            addCell: (label: string, x: number, y: number) => {
              const graph = bindingUi.editor.graph as unknown as LooseGraph
              graph.insertVertex(graph.getDefaultParent(), null, label, x, y, 120, 60)
            },
            cellCount: () => (ydoc2xml(doc).match(/<mxCell /g) ?? []).length,
            undo: () => {
              const manager = bindingUi.editor.undoManager as { undo?: () => void } | undefined
              manager?.undo?.()
            },
          }

          setBootStage('ready')
          showEditor()
          window.dispatchEvent(new Event('resize'))
        }
        const file = ui.currentFile
        if (file !== null) {
          attach(file)
        } else {
          const editor = ui.editor as unknown as {
            addListener(name: string, handler: () => void): void
          }
          editor.addListener('fileLoaded', () => {
            if (ui.currentFile !== null) attach(ui.currentFile)
          })
        }
      },
      () => {
        const EditorClass = drawioWindow.Editor
        if (EditorClass === undefined) {
          throw new Error('draw.io Editor class is missing')
        }
        const container = document.getElementById('drawio-container')
        if (container === null) {
          throw new Error('editor container is missing')
        }
        const editor = new EditorClass(false, null, null, null, true)
        return new App(editor, container)
      },
    )
  }

  if (provider.connected) {
    bindWhenReady()
  } else {
    provider.onConnect(bindWhenReady)
  }
}

void boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown failure'
  setBootStage(`failed: ${message}`)
  console.error('[editor] boot failed:', error)
})
