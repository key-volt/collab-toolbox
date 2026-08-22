// Mirror of the backend tool registry. A backend test asserts both lists agree, so a
// tool added on one side without the other fails CI instead of quietly missing.

export interface ToolInfo {
  slug: string
  title: string
  glyph: string
}

export const TOOLS: ToolInfo[] = [
  { slug: 'drawio', title: 'Diagrams', glyph: '◇' },
  { slug: 'paint', title: 'Paint', glyph: '◈' },
  { slug: 'code', title: 'Code', glyph: '⌗' },
]

export function toolInfo(slug: string): ToolInfo | undefined {
  return TOOLS.find((tool) => tool.slug === slug)
}
