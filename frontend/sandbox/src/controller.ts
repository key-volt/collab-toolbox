// The sandbox page: an xterm terminal plus a graphics pane, talking to the Python/JS
// engine over messages. This page runs at an opaque origin with a network-dead CSP —
// it holds no cookies, no tokens, and can reach nothing but the /sandbox/ assets.
//
// The engine prefers a Worker built from a blob (an opaque origin cannot start a URL
// worker) and falls back to this page's own thread wherever the platform refuses
// that. Stop is owned by the HOST page as a frame reset, so it never depends on
// anything in here cooperating.

import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

interface SandboxFile {
  path: string
  text: string
}

interface EngineMessage {
  out:
    | 'stage'
    | 'stdout'
    | 'stderr'
    | 'result'
    | 'prompt'
    | 'png'
    | 'svg'
    | 'run-done'
    | 'fatal'
  text?: string
  stage?: string
  detail?: string
  ps?: string
  data?: string
}

type EngineCommand =
  | { cmd: 'files'; files: SandboxFile[] }
  | { cmd: 'push'; line: string }
  | { cmd: 'run'; path: string; files: SandboxFile[] }

const PS1 = '>>> '
const PS2 = '... '
// Control characters built from char codes, so no raw control byte and no escape
// ambiguity ever sits in this source file.
const ESC = String.fromCharCode(27)
const RED = ESC + '[31m'
const DIM = ESC + '[2m'
const RESET = ESC + '[0m'
const CLEAR_LINE = ESC + '[2K\r'
const CTRL_C = String.fromCharCode(3)
const BACKSPACE = String.fromCharCode(127)

const terminalHost = document.getElementById('terminal')
const graphicsHost = document.getElementById('graphics')
if (terminalHost === null || graphicsHost === null) {
  throw new Error('sandbox layout is missing')
}
// Narrowing does not flow into the functions declared below, so the checked values
// carry their non-null type explicitly from here on.
const termPane: HTMLElement = terminalHost
const graphicsPane: HTMLElement = graphicsHost

const term = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  theme: {
    background: '#141517',
    foreground: '#e8e6e3',
    cursor: '#8b95ff',
    selectionBackground: '#34363c',
    // Errors print in ANSI red; this keeps it aligned with the app's danger color.
    red: '#ff7a70',
  },
})
const fit = new FitAddon()
term.loadAddon(fit)
term.open(termPane)
fit.fit()
new ResizeObserver(() => {
  try {
    fit.fit()
  } catch {
    // a hidden terminal cannot be measured; the next resize fits it again
  }
}).observe(termPane)

let stage = 'starting'
let engineState: 'booting' | 'ready' | 'busy' = 'booting'
let prompt = PS1
let lineBuffer = ''
let history: string[] = []
let historyIndex = 0
let graphicsCount = 0
let latestFiles: SandboxFile[] = []

function toParent(message: object): void {
  window.parent.postMessage(message, '*')
}

function setStage(next: string, detail?: string): void {
  stage = detail === undefined ? next : `${next} (${detail})`
  toParent({ type: 'stage', stage: next, detail })
}

function writeOutput(text: string): void {
  term.write(text.replace(/\r?\n/g, '\r\n'))
}

// ——— the engine ————————————————————————————————————————————————————————————
//
// Worker-first, page-thread fallback. Blob module workers at an opaque origin sit on
// a specification gap with browser-divergent behavior, so the worker is strictly a
// best-effort upgrade: if it fails to start, the same engine module runs on this
// page's thread instead. Stopping never depends on either mode cooperating — the
// host page resets the whole frame.

interface Engine {
  send: (command: EngineCommand) => void
}

let engine: Engine | null = null

function handleEngineMessage(message: EngineMessage): void {
  switch (message.out) {
    case 'stage':
      setStage(message.stage ?? 'working', message.detail)
      break
    case 'stdout':
      writeOutput(message.text ?? '')
      break
    case 'stderr':
      writeOutput(RED + (message.text ?? '') + RESET)
      break
    case 'result':
      writeOutput(`${message.text ?? ''}\n`)
      break
    case 'prompt':
      prompt = message.ps === 'continuation' ? PS2 : PS1
      engineState = 'ready'
      if (stage !== 'ready') setStage('ready')
      term.write(prompt)
      break
    case 'run-done':
      engineState = 'ready'
      term.write(prompt)
      break
    case 'png':
      showImage(message.data ?? '')
      break
    case 'svg':
      showSvg(message.data ?? '')
      break
    case 'fatal':
      setStage('failed', message.text ?? 'unknown')
      writeOutput(`\nsandbox failed: ${message.text ?? 'unknown'}\n`)
      break
  }
}

function startPageEngine(): Engine {
  // The same engine module, on this page's thread. During a long computation the
  // frame is busy; Stop lives in the host page and resets the frame regardless.
  const globals = window as unknown as {
    __sandboxEngineReceive?: (message: EngineMessage) => void
    __sandboxEngineSend?: (command: EngineCommand) => void
  }
  globals.__sandboxEngineReceive = handleEngineMessage
  const queued: EngineCommand[] = []
  import(/* @vite-ignore */ new URL('worker.js', window.location.href).href)
    .then(() => {
      for (const command of queued.splice(0)) globals.__sandboxEngineSend?.(command)
    })
    .catch(() => setStage('failed', 'engine module did not load'))
  return {
    send: (command) => {
      if (globals.__sandboxEngineSend === undefined) queued.push(command)
      else globals.__sandboxEngineSend(command)
    },
  }
}

function startWorkerEngine(): Engine | null {
  try {
    // An opaque origin cannot start a URL worker, so the worker is a blob module that
    // imports the engine (a MODULE worker — this Pyodide generation is ESM only).
    const bootstrap = `import ${JSON.stringify(new URL('worker.js', window.location.href).href)};`
    const blobUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }))
    const worker = new Worker(blobUrl, { type: 'module' })
    let failedOver = false
    const pending: EngineCommand[] = []
    worker.onmessage = (event: MessageEvent<EngineMessage>) => {
      pending.length = 0 // the worker is alive; nothing to replay on a failover
      handleEngineMessage(event.data)
    }
    // A worker that cannot start fires a plain error event (often with no message at
    // all) before any code of ours runs. That is the platform saying no — fall back
    // to the page thread and replay what was already sent.
    worker.onerror = () => {
      if (failedOver) return
      failedOver = true
      worker.terminate()
      setStage('starting', 'no worker here — running on the page thread')
      engine = startPageEngine()
      for (const command of pending.splice(0)) engine.send(command)
      if (latestFiles.length > 0) engine.send({ cmd: 'files', files: latestFiles })
    }
    return {
      send: (command) => {
        if (failedOver) {
          engine?.send(command)
          return
        }
        pending.push(command)
        worker.postMessage(command)
      },
    }
  } catch {
    return null
  }
}

// ——— graphics ————————————————————————————————————————————————————————————————

function showGraphics(node: Node): void {
  graphicsPane.replaceChildren(node)
  graphicsPane.classList.add('has-content')
  graphicsCount += 1
}

function showImage(base64: string): void {
  const image = document.createElement('img')
  image.src = `data:image/png;base64,${base64}`
  image.alt = 'plot output'
  showGraphics(image)
}

const SVG_TAGS = new Set([
  'svg', 'g', 'defs', 'marker', 'path', 'line', 'rect', 'circle', 'ellipse',
  'polyline', 'polygon', 'text', 'tspan', 'title',
])

interface SvgNode {
  tag?: unknown
  props?: unknown
  children?: unknown
  text?: unknown
}

// The scene arrives as a plain dict describing SVG. User code could hand-craft one,
// so only drawing tags and inert attributes make it into the DOM.
function buildSvgNode(raw: SvgNode): Node | null {
  if (typeof raw.text === 'string') return document.createTextNode(raw.text)
  if (typeof raw.tag !== 'string') return null
  const tag = raw.tag.toLowerCase()
  if (!SVG_TAGS.has(tag)) return null
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag)
  if (typeof raw.props === 'object' && raw.props !== null) {
    for (const [key, value] of Object.entries(raw.props as Record<string, unknown>)) {
      const name = key.toLowerCase()
      if (name.startsWith('on') || name === 'href' || name === 'xlink:href') continue
      if (typeof value === 'string' || typeof value === 'number') {
        element.setAttribute(key, String(value))
      }
    }
  }
  if (Array.isArray(raw.children)) {
    for (const child of raw.children) {
      const built = buildSvgNode(child as SvgNode)
      if (built !== null) element.appendChild(built)
    }
  }
  return element
}

function showSvg(sceneJson: string): void {
  try {
    const built = buildSvgNode(JSON.parse(sceneJson) as SvgNode)
    if (built !== null) showGraphics(built)
  } catch {
    // a malformed scene draws nothing
  }
}

// ——— the line editor ————————————————————————————————————————————————————————

function submitLine(line: string): void {
  if (engine === null) return
  if (line.trim() !== '') {
    history.push(line)
    if (history.length > 100) history = history.slice(-100)
  }
  historyIndex = history.length
  engineState = 'busy'
  engine.send({ cmd: 'push', line })
}

function replaceLine(next: string): void {
  term.write(CLEAR_LINE + prompt + next)
  lineBuffer = next
}

term.onData((data) => {
  if (engineState !== 'ready') {
    // While something runs, input waits; the host page's Stop resets the frame.
    return
  }
  for (const char of data) {
    if (char === '\r') {
      term.write('\r\n')
      const line = lineBuffer
      lineBuffer = ''
      submitLine(line)
    } else if (char === BACKSPACE) {
      if (lineBuffer.length > 0) {
        lineBuffer = lineBuffer.slice(0, -1)
        term.write('\b \b')
      }
    } else if (char === CTRL_C) {
      term.write('^C\r\n')
      lineBuffer = ''
      term.write(prompt)
    } else if (char >= ' ' || char === '\t') {
      lineBuffer += char
      term.write(char)
    }
  }
})

term.attachCustomKeyEventHandler((event) => {
  if (event.type !== 'keydown' || engineState !== 'ready') return true
  if (event.key === 'ArrowUp') {
    if (historyIndex > 0) {
      historyIndex -= 1
      replaceLine(history[historyIndex])
    }
    return false
  }
  if (event.key === 'ArrowDown') {
    if (historyIndex < history.length) {
      historyIndex += 1
      replaceLine(historyIndex < history.length ? history[historyIndex] : '')
    }
    return false
  }
  return true
})

// ——— wiring to the parent ————————————————————————————————————————————————————

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return
  const data = event.data as { type?: unknown; files?: unknown; path?: unknown }
  if (data.type === 'files' && Array.isArray(data.files)) {
    latestFiles = data.files as SandboxFile[]
    engine?.send({ cmd: 'files', files: latestFiles })
  } else if (data.type === 'run' && typeof data.path === 'string' && Array.isArray(data.files)) {
    latestFiles = data.files as SandboxFile[]
    if (engineState === 'busy') {
      writeOutput('\nalready running — Stop first\n')
      return
    }
    engineState = 'busy'
    term.write('\r\n' + DIM + `running ${data.path}` + RESET + '\r\n')
    engine?.send({ cmd: 'run', path: data.path, files: latestFiles })
  }
})

// Deterministic handles for the browser suite; nothing secret lives in this frame.
const debugWindow = window as unknown as { __termDebug?: unknown }
debugWindow.__termDebug = {
  stage: () => stage,
  state: () => engineState,
  graphicsCount: () => graphicsCount,
  push: (line: string) => {
    term.write(`${line}\r\n`)
    submitLine(line)
  },
  text: () => {
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
    }
    return lines.join('\n').trimEnd()
  },
}

setStage('starting')
writeOutput('starting the sandbox…\n')
engine = startWorkerEngine()
if (engine === null) {
  setStage('starting', 'no blob workers — running on the page thread')
  engine = startPageEngine()
}
toParent({ type: 'sandbox-ready' })
