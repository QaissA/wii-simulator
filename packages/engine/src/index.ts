/**
 * @wii/engine — Layer 3 logic, renderer-agnostic by design.
 *
 * Nothing here touches the DOM, WebGL or Three.js. That is deliberate: the parts
 * of a game engine where mistakes are expensive — the input seam, the fixed-step
 * loop, the prediction maths — are exactly the parts that can be tested without
 * a browser. The renderer sits on top (T3.1/T3.4/T3.6) and stays swappable, so a
 * later Godot port touches only that layer.
 */
export * from './input-adapter.js';
export * from './game-loop.js';
export * from './scene-manager.js';
export * from './prediction.js';
export * from './geometry.js';
export * from './audio-director.js';
