/**
 * Local patch, not upstream code.
 *
 * Upstream posts every bridge message with a "*" target origin and never checks
 * event.origin on the way in. Both halves of the bridge are same-origin in this
 * deployment, so every message can be addressed to our own origin and anything
 * arriving from another origin can be dropped. All call sites route through this
 * helper so an upstream merge has one line to re-apply instead of dozens.
 */
export const BRIDGE_TARGET_ORIGIN: string = window.location.origin;

export function postToPeer(target: Window, message: unknown): void {
  target.postMessage(message, BRIDGE_TARGET_ORIGIN);
}

export function isFromBridgeOrigin(event: MessageEvent): boolean {
  return event.origin === BRIDGE_TARGET_ORIGIN;
}
