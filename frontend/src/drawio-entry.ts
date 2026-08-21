// The child half of the diagram editor. This page is served from /drawio/ beside the
// pinned draw.io assets, boots the editor through its internal API, and keeps its local
// Y.Doc in step with the parent shell over the patched postMessage bridge. It talks to
// nothing else: no network, no tokens — the parent owns the connection.

import * as Y from 'yjs'

import { Binding, ydoc2xml } from './vendor/y-mxgraph'
import { createIframeBridgeProvider } from './vendor/y-mxgraph/iframe-bridge'
import type { DrawioFile, DrawioUi } from './vendor/y-mxgraph/types/drawio'

const DRAWIO_BASE = '/drawio/'

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
  PLUGINS_BASE_PATH?: string
  urlParams?: Record<string, string>
}

const drawioWindow = window as unknown as DrawioWindow

function configure(): void {
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
  drawioWindow.PLUGINS_BASE_PATH = DRAWIO_BASE
  // stealth stops draw.io fetching fonts and other resources from third parties —
  // nothing leaves this host at runtime. demo makes it create a blank local file
  // instead of raising its "Save diagrams to:" storage dialog.
  drawioWindow.urlParams = {
    math: '0',
    stealth: '1',
    demo: '1',
    ui: 'dark',
    dark: '1',
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

function showEditor(): void {
  document.getElementById('editor-loading')?.remove()
  const container = document.getElementById('drawio-container')
  if (container !== null) container.style.removeProperty('display')
}

async function boot(): Promise<void> {
  configure()
  linkStylesheet(`${DRAWIO_BASE}mxgraph/css/common.css`)
  linkStylesheet(`${DRAWIO_BASE}styles/grapheditor.css`)
  try {
    await loadScript(`${DRAWIO_BASE}js/PreConfig.js`)
  } catch {
    // PreConfig is optional configuration; the app script carries the editor itself.
  }
  await loadScript(`${DRAWIO_BASE}js/app.min.js`)
  const App = await waitForApp()

  const doc = new Y.Doc()
  const provider = createIframeBridgeProvider(doc, { consistencyCheckInterval: 30_000 })

  let booted = false
  const bindWhenReady = () => {
    if (booted) return
    booted = true
    App.main(
      (ui) => {
        showEditor()
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
  const loading = document.getElementById('editor-loading')
  if (loading !== null) {
    loading.textContent = 'the editor could not start — check the container logs'
  }
  console.error('[editor] boot failed:', error)
})
