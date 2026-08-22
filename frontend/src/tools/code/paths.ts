// Path rules for project files, mirrored from the backend's snapshot validation so a
// bad name is refused in the dialog instead of failing later at save time.

export const MAX_PATH_LENGTH = 200
export const MAX_FOLDER_DEPTH = 8

const COMPONENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/

export function pathError(path: string, options: { folder?: boolean } = {}): string | null {
  if (path === '') return 'a name is required'
  if (path.length > MAX_PATH_LENGTH) {
    return `paths may be at most ${String(MAX_PATH_LENGTH)} characters`
  }
  const parts = path.split('/')
  const depthLimit = options.folder === true ? MAX_FOLDER_DEPTH : MAX_FOLDER_DEPTH + 1
  if (parts.length > depthLimit) {
    return `folders may nest at most ${String(MAX_FOLDER_DEPTH)} levels deep`
  }
  for (const part of parts) {
    if (!COMPONENT.test(part)) {
      return (
        `'${part}' is not a valid name — use letters, digits, '.', '_' and '-', ` +
        "don't start with a dot, and stay under 64 characters"
      )
    }
  }
  return null
}

export function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

export function baseName(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

// The self-heal for concurrent create/rename collisions: the younger file (larger id)
// moves aside under a visible -conflict- name at snapshot time.
export function conflictName(path: string, fileId: string): string {
  const dot = baseName(path).lastIndexOf('.')
  const suffix = `-conflict-${fileId.slice(0, 4)}`
  if (dot <= 0) return path + suffix
  const cut = path.length - (baseName(path).length - dot)
  return path.slice(0, cut) + suffix + path.slice(cut)
}
