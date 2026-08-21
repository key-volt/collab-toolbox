import { useEffect, useState } from 'react'

import { api } from '../lib/api'

// The document title, editable in place from the editor chrome.
export function TitleEditor({ docId, title }: { docId: string; title: string }) {
  const [value, setValue] = useState(title)

  useEffect(() => {
    setValue(title)
  }, [title])

  const commit = () => {
    const trimmed = value.trim()
    if (trimmed === '' || trimmed === title) {
      setValue(title)
      return
    }
    api<unknown>(`/api/documents/${docId}`, { method: 'PATCH', json: { title: trimmed } }).catch(
      () => {
        setValue(title)
      },
    )
  }

  return (
    <input
      aria-label="Document title"
      className="w-56 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium outline-none transition hover:border-border focus:border-accent"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
      }}
    />
  )
}
