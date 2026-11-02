/**
 * @wii/protocol — the shared input contract.
 *
 * This package is the ONLY cross-layer dependency. When a layer needs to know
 * what another layer sends, it imports from here rather than reaching into the
 * other layer's source.
 */
export * from './types.js';
export * from './constants.js';
export * from './codec.js';
export * from './clock.js';
export * from './angles.js';
export * from './quat.js';
export * from './grip.js';
