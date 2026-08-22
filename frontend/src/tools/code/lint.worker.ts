// The lint engines, off the main thread. This is our own trusted code running on the
// app origin — project files are data to it and are only ever parsed, never executed.
// Each engine loads on the first request for its language and is cached after.

export interface WorkerRequest {
  id: number
  task: 'lint-python' | 'lint-javascript' | 'format-python'
  path: string
  text: string
}

export interface WorkerDiagnostic {
  from: number
  to: number
  severity: 'error' | 'warning'
  message: string
}

export interface WorkerResponse {
  id: number
  diagnostics?: WorkerDiagnostic[]
  formatted?: string
  failure?: string
}

// Offsets from ruff's one-based row/column pairs, measured in UTF-16 units to match
// the editor's document positions.
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return starts
}

function offsetAt(starts: number[], length: number, row: number, column: number): number {
  const line = Math.min(Math.max(row - 1, 0), starts.length - 1)
  return Math.min(starts[line] + Math.max(column - 1, 0), length)
}

interface RuffLocation {
  row: number
  column: number
}

interface RuffMessage {
  code: string | null
  message: string
  start_location: RuffLocation
  end_location: RuffLocation
}

type RuffModule = typeof import('@astral-sh/ruff-wasm-web')

let ruffWorkspace: InstanceType<RuffModule['Workspace']> | null = null

async function ruff(): Promise<InstanceType<RuffModule['Workspace']>> {
  if (ruffWorkspace !== null) return ruffWorkspace
  const [mod, wasmUrl] = await Promise.all([
    import('@astral-sh/ruff-wasm-web'),
    import('@astral-sh/ruff-wasm-web/ruff_wasm_bg.wasm?url').then((asset) => asset.default),
  ])
  await mod.default(wasmUrl)
  ruffWorkspace = new mod.Workspace(mod.Workspace.defaultSettings(), mod.PositionEncoding.Utf16)
  return ruffWorkspace
}

async function lintPython(text: string): Promise<WorkerDiagnostic[]> {
  const workspace = await ruff()
  const messages = workspace.check(text) as RuffMessage[]
  const starts = lineStarts(text)
  return messages.map((entry) => {
    const from = offsetAt(starts, text.length, entry.start_location.row, entry.start_location.column)
    const to = offsetAt(starts, text.length, entry.end_location.row, entry.end_location.column)
    return {
      from,
      to: Math.max(to, from),
      // Rule findings advise; a file that does not parse is broken.
      severity: entry.code === null ? ('error' as const) : ('warning' as const),
      message: entry.code === null ? entry.message : `${entry.code}: ${entry.message}`,
    }
  })
}

async function formatPython(text: string): Promise<string> {
  const workspace = await ruff()
  return workspace.format(text)
}

interface EslintMessage {
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  severity: number
  message: string
  ruleId?: string | null
}

interface EslintLike {
  verify: (text: string, config: unknown, filename: string) => EslintMessage[]
}

let eslint: EslintLike | null = null
let eslintConfig: unknown = null

async function lintJavascript(text: string, path: string): Promise<WorkerDiagnostic[]> {
  if (eslint === null) {
    const [{ Linter }, js] = await Promise.all([
      import('eslint-linter-browserify'),
      import('@eslint/js'),
    ])
    eslint = new Linter() as unknown as EslintLike
    eslintConfig = [
      {
        ...js.default.configs.recommended,
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
      },
    ]
  }
  const starts = lineStarts(text)
  return eslint.verify(text, eslintConfig, path).map((entry) => {
    const from = offsetAt(starts, text.length, entry.line ?? 1, entry.column ?? 1)
    const to =
      entry.endLine !== undefined && entry.endColumn !== undefined
        ? offsetAt(starts, text.length, entry.endLine, entry.endColumn)
        : from
    return {
      from,
      to: Math.max(to, from),
      severity: entry.severity === 2 ? ('error' as const) : ('warning' as const),
      message: entry.ruleId == null ? entry.message : `${entry.message} (${entry.ruleId})`,
    }
  })
}

// This file compiles under the page's DOM typings, where self.postMessage wants a
// target origin. Narrow to the worker-shaped surface actually present at runtime.
const scope = self as unknown as {
  postMessage: (message: WorkerResponse) => void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  void (async () => {
    try {
      if (request.task === 'lint-python') {
        const diagnostics = await lintPython(request.text)
        scope.postMessage({ id: request.id, diagnostics })
      } else if (request.task === 'lint-javascript') {
        const diagnostics = await lintJavascript(request.text, request.path)
        scope.postMessage({ id: request.id, diagnostics })
      } else {
        const formatted = await formatPython(request.text)
        scope.postMessage({ id: request.id, formatted })
      }
    } catch (cause) {
      const failure = cause instanceof Error ? cause.message : 'the lint engine failed'
      scope.postMessage({ id: request.id, failure })
    }
  })()
}
