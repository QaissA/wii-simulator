/**
 * Scenery primitives — the shared half of making a game look like something.
 *
 * Everything here is deliberately **unlit**. The games render through
 * `MeshBasicMaterial` with an orthographic camera, which means there is no light
 * rig to tune and no shading to go wrong on a strange GPU: what the colour says
 * is what the screen shows. Depth and mood therefore have to come from colour
 * itself — gradients, layered silhouettes, parallax — rather than from lighting.
 *
 * That constraint is worth keeping. `layer-3-display-engine.md` §Latency & feel
 * asks for a fast first meaningful frame, and the bundle is already 146 kB
 * gzipped of mostly Three.js (§Outstanding for 3b). Vertex colours cost nothing
 * at runtime, add no textures to decode, and need no second material system.
 *
 * Lives in `render/` rather than in either game because the third game is what
 * revealed it wanted sharing — the same rule `packages/engine/src/geometry.ts`
 * came in under.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
} from 'three';

/**
 * A plane shaded from one colour at the top to another at the bottom.
 *
 * The gradient is carried in **vertex colours on the four corners**, which the
 * GPU interpolates for free. A texture would mean generating an image, a decode
 * on the first frame, and a filtering mode to get wrong at the edges.
 *
 * Colours are assigned by reading each vertex's own `y` rather than by assuming
 * Three's vertex ordering, so this cannot silently invert if that ever changes.
 */
export function gradientPlane(
  width: number,
  height: number,
  topHex: number,
  bottomHex: number,
): Mesh {
  const geometry = new PlaneGeometry(width, height);
  const position = geometry.getAttribute('position');
  const top = new Color(topHex);
  const bottom = new Color(bottomHex);

  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const t = (position.getY(i) + height / 2) / height;
    const c = bottom.clone().lerp(top, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));

  return new Mesh(geometry, new MeshBasicMaterial({ vertexColors: true }));
}

/**
 * Scattered points, for a sky.
 *
 * `sizeAttenuation: false` so the size is in pixels rather than world units.
 * Under an orthographic camera the attenuated size depends on the frustum
 * height, which means stars that silently change size whenever a game picks a
 * different view scale.
 *
 * Takes a `random` rather than calling `Math.random`, so a game with a seeded
 * generator keeps its sky reproducible along with its gameplay.
 */
export function starField(
  count: number,
  width: number,
  height: number,
  random: () => number,
  color = 0xffffff,
  size = 2,
): Points {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (random() - 0.5) * width;
    positions[i * 3 + 1] = (random() - 0.5) * height;
    positions[i * 3 + 2] = 0;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));

  return new Points(
    geometry,
    new PointsMaterial({ color, size, sizeAttenuation: false, transparent: true, opacity: 0.7 }),
  );
}

/**
 * A soft silhouette ridge, for a parallax background layer.
 *
 * Built from overlapping squashed circles rather than from a `Shape`: a Shape
 * needs triangulating, and at this size the difference is invisible while the
 * circle version is trivially cheap and impossible to get non-manifold.
 *
 * The group is returned twice as wide as `width` and centred, so a caller can
 * scroll it by one `width` and wrap without a visible seam.
 */
export function ridge(
  width: number,
  height: number,
  color: number,
  bumps: number,
  random: () => number,
): Group {
  const group = new Group();
  const material = new MeshBasicMaterial({ color });
  const span = width * 2;

  for (let i = 0; i < bumps; i++) {
    const r = height * (0.6 + random() * 0.7);
    const bump = new Mesh(new CircleGeometry(r, 20), material);
    bump.position.x = -span / 2 + (i / bumps) * span + (random() - 0.5) * (span / bumps);
    // Squashed, so a circle reads as a hill rather than as a ball.
    bump.scale.y = 0.55;
    group.add(bump);
  }
  return group;
}

/**
 * A circle with a lighter inner disc and a highlight — a ball rather than a dot.
 *
 * The whole trick with an unlit material: a smaller, lighter concentric circle
 * reads as the lit face, and a small off-centre highlight reads as a specular.
 * Two extra draw calls buys most of what shading would.
 *
 * Returns a group so a caller can still move and scale it as one object.
 */
export function shadedDisc(radius: number, color: number, segments = 28): Group {
  const group = new Group();
  const base = new Color(color);

  group.add(new Mesh(new CircleGeometry(radius, segments), new MeshBasicMaterial({ color })));

  const inner = new Mesh(
    new CircleGeometry(radius * 0.72, segments),
    new MeshBasicMaterial({ color: base.clone().lerp(new Color(0xffffff), 0.18) }),
  );
  inner.position.set(-radius * 0.08, radius * 0.08, 0.01);
  group.add(inner);

  const highlight = new Mesh(
    new CircleGeometry(radius * 0.2, 12),
    new MeshBasicMaterial({
      color: base.clone().lerp(new Color(0xffffff), 0.75),
      transparent: true,
      opacity: 0.8,
    }),
  );
  highlight.position.set(-radius * 0.34, radius * 0.34, 0.02);
  group.add(highlight);

  return group;
}
