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
    | 'tk'
    | 'run-done'
    | 'fatal'
  text?: string
  stage?: string
  detail?: string
  ps?: string
  data?: string
}

// A DOM event forwarded into the tkinter emulation's Python dispatcher.
interface TkEventOut {
  wid: number
  event: 'command' | 'var' | 'bind' | 'wm-close'
  seq?: string
  value?: string | number
  checked?: boolean
  index?: number
  x?: number
  y?: number
  keysym?: string
  char?: string
  num?: number
  w?: number
  h?: number
}

type EngineCommand =
  | { cmd: 'files'; files: SandboxFile[] }
  | { cmd: 'push'; line: string }
  | { cmd: 'run'; path: string; files: SandboxFile[] }
  | { cmd: 'tk-event'; event: TkEventOut }

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

// A stalled boot is otherwise indistinguishable from a slow one: the engine reports
// progress only for fetches, and a hung module import or wasm compile reports
// nothing at all. Sixty silent seconds while still booting earn one visible hint.
let lastEngineMessageAt = Date.now()
let bootHintWritten = false
setInterval(() => {
  if (engineState !== 'booting' || bootHintWritten) return
  if (Date.now() - lastEngineMessageAt < 60_000) return
  bootHintWritten = true
  writeOutput('\nstill loading — the connection looks slow or stalled. Stop, then Start, retries.\n')
}, 15_000)

function handleEngineMessage(message: EngineMessage): void {
  lastEngineMessageAt = Date.now()
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
    case 'tk':
      applyTkOps(message.data ?? '')
      break
    case 'fatal':
      setStage('failed', message.text ?? 'unknown')
      writeOutput(`\nsandbox failed: ${message.text ?? 'unknown'} — press Stop, then Start, to retry.\n`)
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
//
// The pane hosts two things: the tkinter window card (persistent while the app
// lives) at the top, and the latest plot or turtle scene below it.

const tkHost = document.createElement('div')
const plotHost = document.createElement('div')
graphicsPane.append(tkHost, plotHost)

function refreshPaneVisibility(): void {
  const hasContent = tkHost.childElementCount > 0 || plotHost.childElementCount > 0
  graphicsPane.classList.toggle('has-content', hasContent)
}

function showGraphics(node: Node): void {
  plotHost.replaceChildren(node)
  refreshPaneVisibility()
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

// ——— the tkinter renderer ———————————————————————————————————————————————————
//
// The Python emulation forwards widget operations as data; this half renders
// them as DOM in the graphics pane and forwards DOM events back. All text lands
// via textContent, so user strings never become markup.

interface TkOp {
  op: string
  wid?: number
  parent?: number
  kind?: string
  title?: string
  manager?: string
  seq?: string
  axis?: string
  // Partial: only configured tracks exist, so index reads are honestly optional.
  tracks?: Partial<Record<string, number>>
  width?: number
  height?: number
  bg?: string
  items?: TkCanvasItem[]
  opts?: Record<string, unknown>
}

interface TkCanvasItem {
  type: string
  coords: number[]
  opts: Record<string, unknown>
}

interface TkWidget {
  kind: string
  el: HTMLElement
  body: HTMLElement
  input: HTMLInputElement | HTMLTextAreaElement | null
  textEl: HTMLElement | null
  svg: SVGSVGElement | null
  valueLabel: HTMLElement | null
  listened: Set<string>
  nextRow: number
  tracks: { row: Partial<Record<string, number>>; column: Partial<Record<string, number>> }
}

// The widget defaults follow the app's graphite theme; programs that set bg/fg
// explicitly get exactly what they asked for. The canvas alone defaults to
// white paper, because Tk drawing code assumes black default strokes.
const TK_COLORS = {
  bg: '#1d1e21',
  raised: '#26272b',
  border: '#34363c',
  text: '#e8e6e3',
  muted: '#a1a1aa',
  accent: '#8b95ff',
  onAccent: '#141517',
}

const tkWidgets = new Map<number, TkWidget>()
const SVG_NS = 'http://www.w3.org/2000/svg'

function sendTkEvent(event: TkEventOut): void {
  engine?.send({ cmd: 'tk-event', event })
}

function tkNum(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function tkStr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

// Tk's "center" anchor value contains compass letters ('e', 'n'), so it must be
// normalized away before any letter matching decides a direction.
function anchorLetters(anchor: string): string {
  return anchor === 'center' ? '' : anchor
}

function cssFont(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const family = tkStr(value[0], 'sans-serif')
    const size = tkNum(value[1], 13)
    const styles = value
      .slice(2)
      .filter((part): part is string => typeof part === 'string')
      .join(' ')
    return `${styles} ${String(size)}px "${family}"`.trim()
  }
  return null
}

function makeRec(kind: string, el: HTMLElement, partial: Partial<TkWidget>): TkWidget {
  return {
    kind,
    el,
    body: partial.body ?? el,
    input: partial.input ?? null,
    textEl: partial.textEl ?? null,
    svg: partial.svg ?? null,
    valueLabel: partial.valueLabel ?? null,
    listened: new Set<string>(),
    nextRow: 0,
    tracks: { row: {}, column: {} },
  }
}

function styleControl(el: HTMLElement): void {
  el.style.background = TK_COLORS.raised
  el.style.color = TK_COLORS.text
  el.style.border = `1px solid ${TK_COLORS.border}`
  el.style.borderRadius = '4px'
  el.style.font = 'inherit'
  el.style.padding = '2px 6px'
}

function buildTkWindow(wid: number, title: string): void {
  const card = document.createElement('div')
  card.dataset.tkId = String(wid)
  card.dataset.tkKind = 'window'
  card.tabIndex = 0
  card.style.border = `1px solid ${TK_COLORS.border}`
  card.style.borderRadius = '8px'
  card.style.overflow = 'hidden'
  card.style.background = TK_COLORS.bg
  card.style.color = TK_COLORS.text
  card.style.font = '13px ui-sans-serif, system-ui, sans-serif'
  card.style.outline = 'none'
  card.style.marginBottom = '8px'
  // A real Tk window sizes to its content (or its geometry), not to the pane.
  card.style.width = 'fit-content'
  card.style.minWidth = '160px'
  card.style.maxWidth = '100%'

  const titleBar = document.createElement('div')
  titleBar.style.display = 'flex'
  titleBar.style.alignItems = 'center'
  titleBar.style.justifyContent = 'space-between'
  titleBar.style.gap = '8px'
  titleBar.style.padding = '4px 8px'
  titleBar.style.background = TK_COLORS.raised
  titleBar.style.borderBottom = `1px solid ${TK_COLORS.border}`
  const titleText = document.createElement('span')
  titleText.dataset.tkTitle = ''
  titleText.textContent = title
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.textContent = '×'
  closeButton.setAttribute('aria-label', 'close the tkinter window')
  closeButton.style.background = 'none'
  closeButton.style.border = 'none'
  closeButton.style.color = TK_COLORS.muted
  closeButton.style.cursor = 'pointer'
  closeButton.style.font = 'inherit'
  closeButton.addEventListener('click', () => {
    sendTkEvent({ wid, event: 'wm-close' })
  })
  titleBar.append(titleText, closeButton)

  const body = document.createElement('div')
  body.style.padding = '8px'
  body.style.position = 'relative'
  card.append(titleBar, body)

  tkWidgets.set(wid, makeRec('window', card, { body }))
  tkHost.replaceChildren(card)
  refreshPaneVisibility()
}

function buildTkWidget(wid: number, kind: string, opts: Record<string, unknown>): TkWidget | null {
  if (kind === 'button') {
    const el = document.createElement('button')
    el.type = 'button'
    styleControl(el)
    el.style.padding = '3px 10px'
    el.style.cursor = 'pointer'
    el.addEventListener('click', () => {
      sendTkEvent({ wid, event: 'command' })
    })
    return makeRec(kind, el, { textEl: el })
  }
  if (kind === 'label') {
    const el = document.createElement('div')
    el.style.whiteSpace = 'pre-line'
    return makeRec(kind, el, { textEl: el })
  }
  if (kind === 'frame') {
    const el = document.createElement('div')
    el.style.position = 'relative'
    return makeRec(kind, el, {})
  }
  if (kind === 'entry') {
    const el = document.createElement('input')
    el.type = tkStr(opts.show, '') === '' ? 'text' : 'password'
    styleControl(el)
    el.style.width = `${String(tkNum(opts.width, 20))}ch`
    el.addEventListener('input', () => {
      sendTkEvent({ wid, event: 'var', value: el.value })
    })
    return makeRec(kind, el, { input: el })
  }
  if (kind === 'text') {
    const el = document.createElement('textarea')
    styleControl(el)
    el.style.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace'
    el.cols = tkNum(opts.width, 40)
    el.rows = tkNum(opts.height, 8)
    el.addEventListener('input', () => {
      sendTkEvent({ wid, event: 'var', value: el.value })
    })
    return makeRec(kind, el, { input: el })
  }
  if (kind === 'canvas') {
    const el = document.createElement('div')
    el.style.display = 'inline-block'
    el.style.lineHeight = '0'
    const svg = document.createElementNS(SVG_NS, 'svg')
    el.appendChild(svg)
    return makeRec(kind, el, { svg })
  }
  if (kind === 'checkbutton' || kind === 'radiobutton') {
    const el = document.createElement('label')
    el.style.display = 'inline-flex'
    el.style.alignItems = 'center'
    el.style.gap = '6px'
    el.style.cursor = 'pointer'
    const input = document.createElement('input')
    input.type = kind === 'checkbutton' ? 'checkbox' : 'radio'
    input.style.accentColor = TK_COLORS.accent
    const text = document.createElement('span')
    el.append(input, text)
    if (kind === 'checkbutton') {
      input.addEventListener('change', () => {
        sendTkEvent({ wid, event: 'command', checked: input.checked })
      })
    } else {
      input.addEventListener('change', () => {
        sendTkEvent({ wid, event: 'command' })
      })
    }
    return makeRec(kind, el, { input, textEl: text })
  }
  if (kind === 'listbox') {
    const el = document.createElement('div')
    styleControl(el)
    el.style.padding = '0'
    el.style.overflowY = 'auto'
    el.style.minWidth = `${String(tkNum(opts.width, 20))}ch`
    el.style.height = `${String(tkNum(opts.height, 10) * 1.4)}em`
    return makeRec(kind, el, {})
  }
  if (kind === 'scale') {
    const el = document.createElement('div')
    el.style.display = 'flex'
    el.style.flexDirection = 'column'
    el.style.gap = '2px'
    const caption = document.createElement('div')
    caption.style.color = TK_COLORS.muted
    const row = document.createElement('div')
    row.style.display = 'flex'
    row.style.alignItems = 'center'
    row.style.gap = '6px'
    const input = document.createElement('input')
    input.type = 'range'
    input.style.accentColor = TK_COLORS.accent
    input.min = String(tkNum(opts.from_, 0))
    input.max = String(tkNum(opts.to, 100))
    input.step = String(tkNum(opts.resolution, 1))
    if (tkStr(opts.orient, 'horizontal') === 'vertical') {
      input.style.writingMode = 'vertical-lr'
      input.style.height = '100px'
    } else {
      input.style.width = '100px'
    }
    const readout = document.createElement('span')
    readout.style.color = TK_COLORS.muted
    if (tkNum(opts.showvalue, 1) === 0) readout.style.display = 'none'
    input.addEventListener('input', () => {
      readout.textContent = input.value
      sendTkEvent({ wid, event: 'command', value: Number(input.value) })
    })
    row.append(input, readout)
    el.append(caption, row)
    return makeRec(kind, el, { input, textEl: caption, valueLabel: readout })
  }
  if (kind === 'scrollbar') {
    // Inert on purpose: the rendered Text and Listbox scroll natively.
    const el = document.createElement('div')
    el.style.display = 'none'
    return makeRec(kind, el, {})
  }
  return null
}

function rebuildListbox(wid: number, rec: TkWidget, items: string[], selection: number[]): void {
  const rows = items.map((item, index) => {
    const row = document.createElement('div')
    row.textContent = item
    row.style.padding = '1px 6px'
    row.style.cursor = 'default'
    if (selection.includes(index)) {
      row.style.background = TK_COLORS.accent
      row.style.color = TK_COLORS.onAccent
    }
    row.addEventListener('click', () => {
      sendTkEvent({ wid, event: 'command', index })
    })
    return row
  })
  rec.el.replaceChildren(...rows)
}

function updateTkWidget(wid: number, rec: TkWidget, opts: Record<string, unknown>): void {
  const text = opts.text
  if (typeof text === 'string' && rec.textEl !== null) rec.textEl.textContent = text
  const fg = opts.fg
  if (typeof fg === 'string') rec.el.style.color = fg
  const bg = opts.bg
  if (typeof bg === 'string') (rec.kind === 'window' ? rec.body : rec.el).style.background = bg
  const font = cssFont(opts.font)
  if (font !== null) rec.el.style.font = font
  const justify = opts.justify
  if (typeof justify === 'string') rec.el.style.textAlign = justify
  const state = opts.state
  if (typeof state === 'string') {
    const target = rec.input ?? rec.el
    if (
      target instanceof HTMLButtonElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      target.disabled = state === 'disabled'
    }
    rec.el.style.opacity = state === 'disabled' ? '0.55' : ''
  }
  if (rec.kind === 'window') {
    const width = opts.width
    if (typeof width === 'number') rec.body.style.width = `${String(width)}px`
    const height = opts.height
    if (typeof height === 'number') rec.body.style.minHeight = `${String(height)}px`
  }
  if (rec.kind === 'entry') {
    const show = opts.show
    if (typeof show === 'string' && rec.input instanceof HTMLInputElement) {
      rec.input.type = show === '' ? 'text' : 'password'
    }
  }
  if (rec.kind === 'text') {
    const wrap = opts.wrap
    if (typeof wrap === 'string' && rec.input !== null) {
      rec.input.style.whiteSpace = wrap === 'none' ? 'pre' : 'pre-wrap'
    }
  }
  const value = opts.value
  if ((typeof value === 'string' || typeof value === 'number') && rec.input !== null) {
    const wanted = String(value)
    // Same-value writes are skipped so an echo from Python never fights the caret.
    if (rec.input.value !== wanted) rec.input.value = wanted
    if (rec.valueLabel !== null) rec.valueLabel.textContent = wanted
  }
  const checked = opts.checked
  if (typeof checked === 'boolean' && rec.input instanceof HTMLInputElement) {
    rec.input.checked = checked
  }
  const group = opts.group
  if (typeof group === 'number' && rec.input instanceof HTMLInputElement) {
    rec.input.name = `tkg${String(group)}`
  }
  if (rec.kind === 'scale') {
    if (rec.input instanceof HTMLInputElement) {
      const from = opts.from_
      if (typeof from === 'number') rec.input.min = String(from)
      const to = opts.to
      if (typeof to === 'number') rec.input.max = String(to)
      const resolution = opts.resolution
      if (typeof resolution === 'number') rec.input.step = String(resolution)
    }
    const label = opts.label
    if (typeof label === 'string' && rec.textEl !== null) rec.textEl.textContent = label
  }
  if (rec.kind === 'listbox') {
    const items = opts.items
    const selection = opts.selection
    if (Array.isArray(items)) {
      rebuildListbox(
        wid,
        rec,
        items.filter((item): item is string => typeof item === 'string'),
        Array.isArray(selection)
          ? selection.filter((item): item is number => typeof item === 'number')
          : [],
      )
    }
  }
}

function applyTkTracks(rec: TkWidget, axis: 'row' | 'column'): void {
  const tracks = rec.tracks[axis]
  const indices = Object.keys(tracks).map((key) => Number(key))
  if (indices.length === 0) return
  const count = Math.max(...indices) + 1
  const template = Array.from({ length: count }, (unused, index) =>
    (tracks[String(index)] ?? 0) > 0 ? '1fr' : 'auto',
  ).join(' ')
  if (axis === 'column') rec.body.style.gridTemplateColumns = template
  else rec.body.style.gridTemplateRows = template
}

function layoutTkWidget(rec: TkWidget, parent: TkWidget, manager: string, opts: Record<string, unknown>): void {
  const el = rec.el
  const body = parent.body
  if (manager === 'pack') {
    if (body.style.display !== 'flex') {
      body.style.display = 'flex'
      const firstSide = tkStr(opts.side, 'top')
      body.style.flexDirection = firstSide === 'left' || firstSide === 'right' ? 'row' : 'column'
      // Tk packs with anchor=center: free cross-axis space centers the widget.
      body.style.alignItems = 'center'
      body.style.gap = '4px'
    }
    const direction = body.style.flexDirection === 'row' ? 'row' : 'column'
    const padx = tkNum(opts.padx, 0)
    const pady = tkNum(opts.pady, 0)
    if (padx !== 0 || pady !== 0) el.style.margin = `${String(pady)}px ${String(padx)}px`
    // The side margins come after the shorthand so "bottom"/"right" survive it.
    const side = tkStr(opts.side, 'top')
    if (side === 'bottom') el.style.marginTop = 'auto'
    if (side === 'right') el.style.marginLeft = 'auto'
    const anchor = anchorLetters(tkStr(opts.anchor, 'center'))
    if (direction === 'column') {
      if (anchor.includes('w')) el.style.alignSelf = 'flex-start'
      if (anchor.includes('e')) el.style.alignSelf = 'flex-end'
    } else {
      if (anchor.includes('n')) el.style.alignSelf = 'flex-start'
      if (anchor.includes('s')) el.style.alignSelf = 'flex-end'
    }
    const fill = tkStr(opts.fill, 'none')
    const crossFill = direction === 'column' ? 'x' : 'y'
    const mainFill = direction === 'column' ? 'y' : 'x'
    if (fill === 'both' || fill === crossFill) el.style.alignSelf = 'stretch'
    if (tkNum(opts.expand, 0) !== 0) {
      if (fill === 'both' || fill === mainFill) {
        el.style.flexGrow = '1'
      } else if (direction === 'column') {
        // Tk's expand grows the parcel, not the widget: the free main-axis space
        // becomes auto margins, split to wherever the anchor does not pin it.
        if (!anchor.includes('n')) el.style.marginTop = 'auto'
        if (!anchor.includes('s')) el.style.marginBottom = 'auto'
      } else {
        if (!anchor.includes('w')) el.style.marginLeft = 'auto'
        if (!anchor.includes('e')) el.style.marginRight = 'auto'
      }
    }
    body.appendChild(el)
    return
  }
  if (manager === 'grid') {
    if (body.style.display !== 'grid') {
      body.style.display = 'grid'
      body.style.gap = '4px'
      // Tk centers a widget in its cell unless sticky pins it to an edge.
      body.style.justifyItems = 'center'
      body.style.alignItems = 'center'
    }
    applyTkTracks(parent, 'row')
    applyTkTracks(parent, 'column')
    const givenRow = opts.row
    const row = typeof givenRow === 'number' ? givenRow : parent.nextRow
    parent.nextRow = Math.max(parent.nextRow, row + 1)
    const column = tkNum(opts.column, 0)
    el.style.gridRow = `${String(row + 1)} / span ${String(tkNum(opts.rowspan, 1))}`
    el.style.gridColumn = `${String(column + 1)} / span ${String(tkNum(opts.columnspan, 1))}`
    const sticky = tkStr(opts.sticky, '')
    if (sticky.includes('e') && sticky.includes('w')) el.style.justifySelf = 'stretch'
    else if (sticky.includes('e')) el.style.justifySelf = 'end'
    else if (sticky.includes('w')) el.style.justifySelf = 'start'
    if (sticky.includes('n') && sticky.includes('s')) el.style.alignSelf = 'stretch'
    else if (sticky.includes('n')) el.style.alignSelf = 'start'
    else if (sticky.includes('s')) el.style.alignSelf = 'end'
    const padx = tkNum(opts.padx, 0)
    const pady = tkNum(opts.pady, 0)
    if (padx !== 0 || pady !== 0) el.style.margin = `${String(pady)}px ${String(padx)}px`
    body.appendChild(el)
    return
  }
  body.style.position = 'relative'
  el.style.position = 'absolute'
  const relx = opts.relx
  el.style.left = typeof relx === 'number' ? `${String(relx * 100)}%` : `${String(tkNum(opts.x, 0))}px`
  const rely = opts.rely
  el.style.top = typeof rely === 'number' ? `${String(rely * 100)}%` : `${String(tkNum(opts.y, 0))}px`
  const relwidth = opts.relwidth
  const width = opts.width
  if (typeof relwidth === 'number') el.style.width = `${String(relwidth * 100)}%`
  else if (typeof width === 'number') el.style.width = `${String(width)}px`
  const relheight = opts.relheight
  const height = opts.height
  if (typeof relheight === 'number') el.style.height = `${String(relheight * 100)}%`
  else if (typeof height === 'number') el.style.height = `${String(height)}px`
  // The anchor names which point of the widget sits on (x, y); nw is Tk's default.
  const anchor = anchorLetters(tkStr(opts.anchor, 'nw'))
  const shiftX = anchor.includes('w') ? 0 : anchor.includes('e') ? -100 : -50
  const shiftY = anchor.includes('n') ? 0 : anchor.includes('s') ? -100 : -50
  if (shiftX !== 0 || shiftY !== 0) {
    el.style.transform = `translate(${String(shiftX)}%, ${String(shiftY)}%)`
  }
  body.appendChild(el)
}

const TK_KEYSYMS: Partial<Record<string, string>> = {
  Enter: 'Return',
  Escape: 'Escape',
  ' ': 'space',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Backspace: 'BackSpace',
  Tab: 'Tab',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'Prior',
  PageDown: 'Next',
}

function keysymFor(key: string): string {
  return TK_KEYSYMS[key] ?? key
}

function positionIn(el: HTMLElement, event: MouseEvent): { x: number; y: number } {
  const rect = el.getBoundingClientRect()
  return { x: Math.round(event.clientX - rect.left), y: Math.round(event.clientY - rect.top) }
}

function attachTkListener(wid: number, rec: TkWidget, seq: string): void {
  if (rec.listened.has(seq)) return
  rec.listened.add(seq)
  const el = rec.el
  const sendMouse = (event: MouseEvent, num: number) => {
    const { x, y } = positionIn(el, event)
    sendTkEvent({ wid, event: 'bind', seq, x, y, num })
  }
  const sendKey = (event: KeyboardEvent) => {
    sendTkEvent({
      wid,
      event: 'bind',
      seq,
      keysym: keysymFor(event.key),
      char: event.key.length === 1 ? event.key : '',
    })
  }
  const keyTarget = rec.input ?? el
  if (rec.input === null && (seq.startsWith('<Key') || seq === '<FocusIn>' || seq === '<FocusOut>')) {
    el.tabIndex = 0
  }
  if (seq === '<Button-1>' || seq === '<Button-2>' || seq === '<Button-3>') {
    const wanted = Number(seq.slice('<Button-'.length, -1))
    el.addEventListener('mousedown', (event) => {
      if (event.button === wanted - 1) sendMouse(event, wanted)
    })
  } else if (seq === '<ButtonRelease-1>') {
    el.addEventListener('mouseup', (event) => {
      if (event.button === 0) sendMouse(event, 1)
    })
  } else if (seq === '<Double-Button-1>') {
    el.addEventListener('dblclick', (event) => {
      sendMouse(event, 1)
    })
  } else if (seq === '<Motion>' || seq === '<B1-Motion>') {
    let lastSent = 0
    el.addEventListener('mousemove', (event) => {
      if (seq === '<B1-Motion>' && (event.buttons & 1) === 0) return
      const now = performance.now()
      if (now - lastSent < 33) return
      lastSent = now
      sendMouse(event, 0)
    })
  } else if (seq === '<Enter>') {
    el.addEventListener('mouseenter', (event) => {
      sendMouse(event, 0)
    })
  } else if (seq === '<Leave>') {
    el.addEventListener('mouseleave', (event) => {
      sendMouse(event, 0)
    })
  } else if (seq === '<FocusIn>') {
    keyTarget.addEventListener('focusin', () => {
      sendTkEvent({ wid, event: 'bind', seq })
    })
  } else if (seq === '<FocusOut>') {
    keyTarget.addEventListener('focusout', () => {
      sendTkEvent({ wid, event: 'bind', seq })
    })
  } else if (seq === '<Key>') {
    keyTarget.addEventListener('keydown', sendKey)
  } else if (seq === '<KeyRelease>') {
    keyTarget.addEventListener('keyup', sendKey)
  } else if (seq.startsWith('<Key-')) {
    const wanted = seq.slice('<Key-'.length, -1)
    keyTarget.addEventListener('keydown', (event) => {
      if (keysymFor(event.key) === wanted) sendKey(event)
    })
  } else if (seq === '<Configure>') {
    requestAnimationFrame(() => {
      sendTkEvent({ wid, event: 'bind', seq, w: el.clientWidth, h: el.clientHeight })
    })
  }
}

function buildTkCanvasItem(item: TkCanvasItem): SVGElement | null {
  const coords = item.coords
  const opts = item.opts
  const stroke = (name: string, fallback: string) => {
    const value = tkStr(opts[name], fallback)
    return value === '' ? 'none' : value
  }
  if (item.type === 'line' && coords.length >= 4) {
    const el = document.createElementNS(SVG_NS, 'polyline')
    const points: string[] = []
    for (let index = 0; index + 1 < coords.length; index += 2) {
      points.push(`${String(coords[index])},${String(coords[index + 1])}`)
    }
    el.setAttribute('points', points.join(' '))
    el.setAttribute('fill', 'none')
    el.setAttribute('stroke', stroke('fill', '#000000'))
    el.setAttribute('stroke-width', String(tkNum(opts.width, 1)))
    return el
  }
  if ((item.type === 'rectangle' || item.type === 'oval') && coords.length >= 4) {
    const [x1, y1, x2, y2] = coords
    const left = Math.min(x1, x2)
    const top = Math.min(y1, y2)
    const width = Math.abs(x2 - x1)
    const height = Math.abs(y2 - y1)
    let el: SVGElement
    if (item.type === 'rectangle') {
      el = document.createElementNS(SVG_NS, 'rect')
      el.setAttribute('x', String(left))
      el.setAttribute('y', String(top))
      el.setAttribute('width', String(width))
      el.setAttribute('height', String(height))
    } else {
      el = document.createElementNS(SVG_NS, 'ellipse')
      el.setAttribute('cx', String(left + width / 2))
      el.setAttribute('cy', String(top + height / 2))
      el.setAttribute('rx', String(width / 2))
      el.setAttribute('ry', String(height / 2))
    }
    el.setAttribute('fill', stroke('fill', 'none'))
    el.setAttribute('stroke', stroke('outline', '#000000'))
    el.setAttribute('stroke-width', String(tkNum(opts.width, 1)))
    return el
  }
  if (item.type === 'polygon' && coords.length >= 6) {
    const el = document.createElementNS(SVG_NS, 'polygon')
    const points: string[] = []
    for (let index = 0; index + 1 < coords.length; index += 2) {
      points.push(`${String(coords[index])},${String(coords[index + 1])}`)
    }
    el.setAttribute('points', points.join(' '))
    el.setAttribute('fill', stroke('fill', '#000000'))
    el.setAttribute('stroke', stroke('outline', 'none'))
    return el
  }
  if (item.type === 'arc' && coords.length >= 4) {
    const [x1, y1, x2, y2] = coords
    const cx = (x1 + x2) / 2
    const cy = (y1 + y2) / 2
    const rx = Math.abs(x2 - x1) / 2
    const ry = Math.abs(y2 - y1) / 2
    const start = (tkNum(opts.start, 0) * Math.PI) / 180
    const extent = (tkNum(opts.extent, 90) * Math.PI) / 180
    const startPoint = [cx + rx * Math.cos(start), cy - ry * Math.sin(start)]
    const endPoint = [cx + rx * Math.cos(start + extent), cy - ry * Math.sin(start + extent)]
    const large = Math.abs(extent) > Math.PI ? 1 : 0
    const arcPath =
      `A ${String(rx)} ${String(ry)} 0 ${String(large)} 0` +
      ` ${String(endPoint[0])} ${String(endPoint[1])}`
    const el = document.createElementNS(SVG_NS, 'path')
    if (tkStr(opts.style, 'pieslice') === 'arc') {
      el.setAttribute(
        'd',
        `M ${String(startPoint[0])} ${String(startPoint[1])} ${arcPath}`,
      )
      el.setAttribute('fill', 'none')
    } else {
      el.setAttribute(
        'd',
        `M ${String(cx)} ${String(cy)} L ${String(startPoint[0])} ${String(startPoint[1])} ${arcPath} Z`,
      )
      el.setAttribute('fill', stroke('fill', 'none'))
    }
    el.setAttribute('stroke', stroke('outline', '#000000'))
    el.setAttribute('stroke-width', String(tkNum(opts.width, 1)))
    return el
  }
  if (item.type === 'text' && coords.length >= 2) {
    const el = document.createElementNS(SVG_NS, 'text')
    el.setAttribute('x', String(coords[0]))
    el.setAttribute('y', String(coords[1]))
    el.setAttribute('fill', stroke('fill', '#000000'))
    const anchor = anchorLetters(tkStr(opts.anchor, 'center'))
    el.setAttribute('text-anchor', anchor.includes('w') ? 'start' : anchor.includes('e') ? 'end' : 'middle')
    el.setAttribute('dominant-baseline', anchor.includes('n') ? 'hanging' : anchor.includes('s') ? 'auto' : 'middle')
    const font = cssFont(opts.font)
    el.style.font = font ?? '13px sans-serif'
    el.textContent = tkStr(opts.text, '')
    return el
  }
  return null
}

function renderTkCanvas(rec: TkWidget, op: TkOp): void {
  if (rec.svg === null) return
  const width = op.width ?? 300
  const height = op.height ?? 200
  rec.svg.setAttribute('width', String(width))
  rec.svg.setAttribute('height', String(height))
  rec.svg.setAttribute('viewBox', `0 0 ${String(width)} ${String(height)}`)
  rec.svg.style.background = op.bg ?? '#ffffff'
  rec.svg.style.borderRadius = '4px'
  const built: SVGElement[] = []
  for (const item of op.items ?? []) {
    const node = buildTkCanvasItem(item)
    if (node !== null) built.push(node)
  }
  rec.svg.replaceChildren(...built)
}

function applyTkOp(op: TkOp): void {
  const wid = op.wid ?? -1
  if (op.op === 'window') {
    const existing = tkWidgets.get(wid)
    if (existing === undefined) {
      buildTkWindow(wid, op.title ?? 'tk')
    } else {
      const title = existing.el.querySelector('[data-tk-title]')
      if (title !== null) title.textContent = op.title ?? 'tk'
    }
    return
  }
  if (op.op === 'close') {
    tkWidgets.clear()
    tkHost.replaceChildren()
    refreshPaneVisibility()
    return
  }
  const rec = tkWidgets.get(wid)
  if (op.op === 'create') {
    const parent = tkWidgets.get(op.parent ?? -1)
    if (parent === undefined || rec !== undefined) return
    const built = buildTkWidget(wid, op.kind ?? '', op.opts ?? {})
    if (built === null) return
    built.el.dataset.tkId = String(wid)
    built.el.dataset.tkKind = op.kind ?? ''
    tkWidgets.set(wid, built)
    updateTkWidget(wid, built, op.opts ?? {})
    return
  }
  if (rec === undefined) return
  if (op.op === 'config') {
    updateTkWidget(wid, rec, op.opts ?? {})
  } else if (op.op === 'layout') {
    const parent = findTkParent(rec)
    if (parent !== undefined) layoutTkWidget(rec, parent, op.manager ?? 'pack', op.opts ?? {})
  } else if (op.op === 'forget') {
    rec.el.remove()
  } else if (op.op === 'tracks') {
    if (op.axis === 'row' || op.axis === 'column') {
      rec.tracks[op.axis] = op.tracks ?? {}
      if (rec.body.style.display === 'grid') applyTkTracks(rec, op.axis)
    }
  } else if (op.op === 'canvas') {
    renderTkCanvas(rec, op)
    refreshPaneVisibility()
  } else if (op.op === 'destroy') {
    rec.el.remove()
    for (const [key, value] of tkWidgets) {
      if (!value.el.isConnected) tkWidgets.delete(key)
    }
    refreshPaneVisibility()
  } else if (op.op === 'listen') {
    attachTkListener(wid, rec, op.seq ?? '')
  } else if (op.op === 'focus') {
    const target = rec.input ?? rec.el
    target.focus()
  }
}

// Layout ops name only the child; its parent is found through the emitted order
// (children are always created after their parent and carry its element).
const tkParents = new Map<number, number>()

function findTkParent(rec: TkWidget): TkWidget | undefined {
  const parentId = tkParents.get(Number(rec.el.dataset.tkId ?? '-1'))
  return parentId === undefined ? undefined : tkWidgets.get(parentId)
}

function applyTkOps(data: string): void {
  try {
    const ops = JSON.parse(data) as TkOp[]
    for (const op of ops) {
      if (op.op === 'create' && op.wid !== undefined && op.parent !== undefined) {
        tkParents.set(op.wid, op.parent)
      }
      if (op.op === 'close') tkParents.clear()
      applyTkOp(op)
    }
  } catch {
    // a malformed batch renders nothing
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
