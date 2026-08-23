// Language wiring by file extension: syntax highlighting for everything named here,
// live lint where a safe engine exists. Unknown extensions edit as plain text.

import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'
import type { Extension } from '@codemirror/state'

// 'worker' engines run in the shared lint worker (Ruff WASM, ESLint). 'syntax' reads
// error nodes from the editor's own parse tree — that is what TypeScript files get:
// ESLint's parser cannot read TS syntax, and shipping the TS compiler for it was
// rejected as far too heavy for a syntax check.
export type LintKind = 'python' | 'javascript' | 'json' | 'yaml' | 'syntax' | null

export interface LanguageSpec {
  name: string
  extension: Extension
  lint: LintKind
  fourSpaceIndent?: boolean
  runnable?: 'python' | 'javascript'
}

// Partial: indexing by an arbitrary extension really can miss, and the type says so.
const BY_EXTENSION: Partial<Record<string, () => LanguageSpec>> = {
  py: () => ({
    name: 'Python',
    extension: python(),
    lint: 'python',
    fourSpaceIndent: true,
    runnable: 'python',
  }),
  js: () => ({ name: 'JavaScript', extension: javascript(), lint: 'javascript', runnable: 'javascript' }),
  jsx: () => ({
    name: 'JSX',
    extension: javascript({ jsx: true }),
    lint: 'javascript',
    runnable: 'javascript',
  }),
  ts: () => ({ name: 'TypeScript', extension: javascript({ typescript: true }), lint: 'syntax' }),
  tsx: () => ({
    name: 'TSX',
    extension: javascript({ typescript: true, jsx: true }),
    lint: 'syntax',
  }),
  json: () => ({ name: 'JSON', extension: json(), lint: 'json' }),
  yml: () => ({ name: 'YAML', extension: yaml(), lint: 'yaml' }),
  yaml: () => ({ name: 'YAML', extension: yaml(), lint: 'yaml' }),
  md: () => ({ name: 'Markdown', extension: markdown(), lint: null }),
  html: () => ({ name: 'HTML', extension: html(), lint: null }),
  css: () => ({ name: 'CSS', extension: css(), lint: null }),
}

const PLAIN: LanguageSpec = { name: 'Plain text', extension: [], lint: null }

export function languageFor(path: string): LanguageSpec {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return PLAIN
  const factory = BY_EXTENSION[path.slice(dot + 1).toLowerCase()]
  return factory === undefined ? PLAIN : factory()
}
