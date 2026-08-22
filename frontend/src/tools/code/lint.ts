// Editor-side lint wiring: one shared worker session per page, a linter source per
// language, and the Python formatter riding the same worker. All engines parse only.

import { jsonParseLinter } from '@codemirror/lang-json'
import { syntaxTree } from '@codemirror/language'
import { linter, type Diagnostic, type LintSource } from '@codemirror/lint'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { parseDocument } from 'yaml'

import type { LintKind } from './languages'
import type { WorkerDiagnostic, WorkerRequest, WorkerResponse } from './lint.worker'

const LINT_DELAY_MS = 300

let worker: Worker | null = null
let nextRequestId = 0
const pending = new Map<number, (response: WorkerResponse) => void>()

function lintWorker(): Worker {
  if (worker === null) {
    worker = new Worker(new URL('./lint.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const resolve = pending.get(event.data.id)
      if (resolve !== undefined) {
        pending.delete(event.data.id)
        resolve(event.data)
      }
    }
  }
  return worker
}

function ask(task: WorkerRequest['task'], path: string, text: string): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    nextRequestId += 1
    const request: WorkerRequest = { id: nextRequestId, task, path, text }
    pending.set(request.id, resolve)
    lintWorker().postMessage(request)
  })
}

function clamp(diagnostics: WorkerDiagnostic[], docLength: number): Diagnostic[] {
  return diagnostics.map((entry) => {
    const from = Math.min(entry.from, docLength)
    return {
      from,
      to: Math.min(Math.max(entry.to, from), docLength),
      severity: entry.severity,
      message: entry.message,
    }
  })
}

function workerSource(task: 'lint-python' | 'lint-javascript', path: string): LintSource {
  return async (view: EditorView) => {
    const text = view.state.doc.toString()
    const response = await ask(task, path, text)
    if (response.diagnostics === undefined) return []
    // The document may have changed while the worker ran; the linter re-runs on the
    // next change anyway, so stale results are only clamped, never re-mapped.
    return clamp(response.diagnostics, view.state.doc.length)
  }
}

// TypeScript files: error nodes from the editor's own grammar. This is a syntax-level
// check by design — ESLint's parser cannot read TS, and the TS compiler is far too
// heavy to ship for squiggles.
const syntaxErrorSource: LintSource = (view: EditorView) => {
  const diagnostics: Diagnostic[] = []
  syntaxTree(view.state)
    .cursor()
    .iterate((node) => {
      if (!node.type.isError) return
      const from = node.from
      const to = node.to > from ? node.to : Math.min(from + 1, view.state.doc.length)
      diagnostics.push({ from, to, severity: 'error', message: 'syntax error' })
    })
  return diagnostics
}

const yamlSource: LintSource = (view: EditorView) => {
  const text = view.state.doc.toString()
  return parseDocument(text).errors.map((error) => {
    const [from, to] = error.pos
    return {
      from: Math.min(from, text.length),
      to: Math.min(Math.max(to, from), text.length),
      severity: 'error' as const,
      message: error.message,
    }
  })
}

export function lintExtensionFor(kind: LintKind, path: string): Extension {
  switch (kind) {
    case 'python':
      return linter(workerSource('lint-python', path), { delay: LINT_DELAY_MS })
    case 'javascript':
      return linter(workerSource('lint-javascript', path), { delay: LINT_DELAY_MS })
    case 'json':
      return linter(jsonParseLinter(), { delay: LINT_DELAY_MS })
    case 'yaml':
      return linter(yamlSource, { delay: LINT_DELAY_MS })
    case 'syntax':
      return linter(syntaxErrorSource, { delay: LINT_DELAY_MS })
    case null:
      return []
  }
}

export async function formatPython(text: string): Promise<string | null> {
  const response = await ask('format-python', 'format.py', text)
  return response.formatted ?? null
}
