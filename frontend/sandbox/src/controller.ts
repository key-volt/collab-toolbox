// The sandbox page: an xterm terminal plus a graphics pane, talking to the Python/JS
// engine over messages. This page runs at an opaque origin with a network-dead CSP —
// it holds no cookies, no tokens, and can reach nothing but the /sandbox/ assets.
//
// The engine runs in a Worker built from a blob (an opaque origin cannot start a URL
// worker), so Stop can always terminate it. Where blob workers are unavailable the
// engine runs on this page's own thread instead, and Stop becomes a page reload.

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

const term = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  theme: {
    background: '#0b0b0d',
    foreground: '#e7e7ea',
    cursor: '#6d7cff',
    selectionBackground: '#26262e',
  },
})
const fit = new FitAddon()
term.loadAddon(fit)
term.open(terminalHost)
fit.fit()
new ResizeObserver(() => {
  try {
    fit.fit()
  } catch {
    // a hidden terminal cannot be measured; the next resize fits it again
  }
}).observe(terminalHost)

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

// ——— the engine, worker-first ———————————————————————————————————————————————

interface Engine {
  send: (command: EngineCommand) => void
  stop: () => void
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
      setStage('failed', message.text)
      writeOutput(`\nsandbox failed: ${message.text ?? 'unknown'}\n`)
      break
  }
}

function startWorkerEngine(): Engine | null {
  try {
    const base = new URL('.', window.location.href).href
    const bootstrap = `self.__SANDBOX_BASE=${JSON.stringify(base)};importScripts(${JSON.stringify(
      new URL('worker.js', base).href,
    )});`
    const blobUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }))
    const worker = new Worker(blobUrl)
    worker.onmessage = (event: MessageEvent<EngineMessage>) => handleEngineMessage(event.data)
    worker.onerror = (event: ErrorEvent) => {
      setStage('failed', event.message)
      writeOutput(`\nsandbox worker error: ${event.message}\n`)
    }
    return {
      send: (command) => worker.postMessage(command),
      stop: () => {
        worker.terminate()
        writeOutput('\n' + RED + 'stopped' + RESET + '\n')
        engineState = 'booting'
        setStage('restarting')
        engine = startWorkerEngine()
        if (engine !== null && latestFiles.length > 0) {
          engine.send({ cmd: 'files', files: latestFiles })
        }
      },
    }
  } catch {
    return null
  }
}

function startPageEngine(): Engine {
  // No blob workers here: run the engine on this page's thread. The engine script is
  // written to work in both contexts; Stop becomes a reload of the frame.
  const globals = window as unknown as {
    __SANDBOX_BASE?: string
    __sandboxEngineReceive?: (message: EngineMessage) => void
    __sandboxEngineSend?: (command: EngineCommand) => void
  }
  globals.__SANDBOX_BASE = new URL('.', window.location.href).href
  globals.__sandboxEngineReceive = handleEngineMessage
  const queued: EngineCommand[] = []
  const script = document.createElement('script')
  script.src = new URL('worker.js', window.location.href).href
  script.onload = () => {
    for (const command of queued.splice(0)) globals.__sandboxEngineSend?.(command)
  }
  script.onerror = () => setStage('failed', 'engine script did not load')
  document.head.appendChild(script)
  return {
    send: (command) => {
      if (globals.__sandboxEngineSend === undefined) queued.push(command)
      else globals.__sandboxEngineSend(command)
    },
    stop: () => window.location.reload(),
  }
}

// ——— graphics ————————————————————————————————————————————————————————————————

function showGraphics(node: Node): void {
  graphicsHost.replaceChildren(node)
  graphicsHost.classList.add('has-content')
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
    // Ctrl+C while something runs is the terminal-native way to say Stop.
    if (data === CTRL_C) engine?.stop()
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
  } else if (data.type === 'stop') {
    engine?.stop()
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
