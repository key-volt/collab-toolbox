// The shared room, from the client side: one Y.Doc per open document, synchronized over
// a websocket whose handshake carries the access token in the subprotocol header. When
// the server closes the socket because the token aged out, the session reconnects with
// a fresh one; when it closes because access was revoked, the editor is told to stop.

import type { Awareness } from 'y-protocols/awareness'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'

const CLOSE_UNAUTHORIZED = 4401
const CLOSE_FORBIDDEN = 4403
const CLOSE_NOT_FOUND = 4404

export interface RoomHandlers {
  onStatus?: (connected: boolean) => void
  onSynced?: () => void
  onDenied?: () => void
}

function roomServerUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/ws`
}

export class RoomSession {
  readonly doc = new Y.Doc()
  provider: WebsocketProvider | null = null
  private destroyed = false

  constructor(
    private readonly tool: string,
    private readonly docId: string,
    private readonly getToken: () => string | null,
    private readonly refreshToken: () => Promise<string | null>,
    private readonly handlers: RoomHandlers = {},
  ) {}

  get awareness(): Awareness | null {
    return this.provider?.awareness ?? null
  }

  connect(): void {
    if (this.destroyed || this.provider !== null) return
    const token = this.getToken()
    if (token === null) {
      this.handlers.onDenied?.()
      return
    }
    const provider = new WebsocketProvider(roomServerUrl(), `${this.tool}/${this.docId}`, this.doc, {
      protocols: ['collab.v1', `bearer.${token}`],
    })
    this.provider = provider
    provider.on('status', (event: { status: string }) => {
      this.handlers.onStatus?.(event.status === 'connected')
    })
    provider.on('sync', (synced: boolean) => {
      if (synced) this.handlers.onSynced?.()
    })
    provider.on('connection-close', (event: CloseEvent | null) => {
      if (this.destroyed || event === null) return
      if (event.code === CLOSE_UNAUTHORIZED) {
        // The token aged out; swap in a fresh one and reconnect. The provider object is
        // kept — recreating it would also recreate awareness, which the editors and the
        // draw.io bridge hold references to.
        provider.disconnect()
        void this.refreshToken().then((renewed) => {
          if (this.destroyed) return
          if (renewed !== null) {
            ;(provider as unknown as { protocols: string[] }).protocols = [
              'collab.v1',
              `bearer.${renewed}`,
            ]
            provider.connect()
          } else {
            this.handlers.onDenied?.()
          }
        })
      } else if (event.code === CLOSE_FORBIDDEN || event.code === CLOSE_NOT_FOUND) {
        provider.disconnect()
        this.handlers.onDenied?.()
      }
    })
  }

  destroy(): void {
    this.destroyed = true
    if (this.provider !== null) {
      this.provider.destroy()
      this.provider = null
    }
    this.doc.destroy()
  }
}

// The elected client is the lowest Yjs client id among peers that may write.
// Deterministic, needs no coordination, re-elects by itself when that peer leaves —
// and a read-only spectator can never win, because whatever it wrote (a seed, a
// snapshot) would be dropped by the server and lost.
export function isElected(awareness: Awareness): boolean {
  const ids: number[] = []
  for (const [clientId, state] of awareness.getStates()) {
    const user = (state as { user?: { canEdit?: boolean } }).user
    if (user?.canEdit === true) ids.push(clientId)
  }
  return ids.length > 0 && Math.min(...ids) === awareness.clientID
}

// One colour per person, derived from the user id, so everyone sees the same colour
// for the same collaborator.
export function colorFor(seed: string): string {
  let hash = 5381
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) + hash) ^ seed.charCodeAt(index)
  }
  hash >>>= 0
  const hue = hash % 360
  const saturation = 65 + ((hash >>> 8) % 20)
  const lightness = 55 + ((hash >>> 16) % 10)
  return `hsl(${String(hue)} ${String(saturation)}% ${String(lightness)}%)`
}

export interface Peer {
  clientId: number
  name: string
  color: string
  canEdit: boolean
}

// The presence roster, read from awareness. Every tool publishes the same user fields.
export function peersFrom(awareness: Awareness): Peer[] {
  const peers: Peer[] = []
  for (const [clientId, state] of awareness.getStates()) {
    const user = (state as { user?: { name?: string; color?: string; canEdit?: boolean } }).user
    peers.push({
      clientId,
      name: user?.name ?? `guest-${String(clientId)}`,
      color: user?.color ?? '#6b6156',
      canEdit: user?.canEdit === true,
    })
  }
  return peers.sort((a, b) => a.clientId - b.clientId)
}
