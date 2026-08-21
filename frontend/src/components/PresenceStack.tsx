import * as Tooltip from '@radix-ui/react-tooltip'

import type { Peer } from '../lib/collab'

export function PresenceStack({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null
  return (
    <Tooltip.Provider delayDuration={200}>
      <div className="flex items-center -space-x-1.5" data-testid="presence-stack">
        {peers.map((peer) => (
          <Tooltip.Root key={peer.clientId}>
            <Tooltip.Trigger asChild>
              <span
                className="border-bg flex h-6 w-6 items-center justify-center rounded-full border-2 text-[10px] font-semibold text-black/80 uppercase"
                style={{ backgroundColor: peer.color }}
              >
                {peer.name.slice(0, 1)}
              </span>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                sideOffset={6}
                className="rounded-md border border-border bg-raised px-2 py-1 text-xs"
              >
                {peer.name}
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        ))}
      </div>
    </Tooltip.Provider>
  )
}
