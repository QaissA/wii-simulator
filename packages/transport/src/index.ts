/**
 * @wii/transport — Layer 2 client side.
 *
 * Shared by the controller (Layer 1) and the display (Layer 3) so the two can
 * never disagree about how frames are delivered — the same argument the protocol
 * package makes for the message format itself.
 */
export * from './channel-router.js';
export * from './heartbeat.js';
export * from './ws-router.js';
