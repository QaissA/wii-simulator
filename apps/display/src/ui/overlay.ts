/**
 * Overlay — the DOM layer above the WebGL canvas.
 *
 * Text, the room code and the QR are DOM rather than rendered geometry. Two
 * reasons, both practical: a QR drawn as a texture has to survive mipmapping
 * without losing module edges (a blurry QR simply does not scan), and crisp text
 * on a TV across a room is exactly what the browser's own text rasteriser is
 * already good at.
 *
 * The overlay is `pointer-events: none` by default so it never eats input
 * destined for the canvas; individual controls opt back in.
 */

export type StatusTone = 'idle' | 'good' | 'warn' | 'bad';

export class Overlay {
  readonly root: HTMLDivElement;
  readonly center: HTMLDivElement;
  readonly hud: HTMLDivElement;
  readonly status: HTMLDivElement;

  constructor(parent: HTMLElement = document.body) {
    this.root = el('div', 'overlay');
    this.center = el('div', 'overlay-center');
    this.hud = el('div', 'overlay-hud');
    this.status = el('div', 'overlay-status');

    this.root.append(this.center, this.hud, this.status);
    parent.append(this.root);
  }

  /** Replace the centre panel. Passing `null` clears it. */
  setCenter(node: Node | null): void {
    this.center.replaceChildren(...(node ? [node] : []));
  }

  setStatus(text: string, tone: StatusTone = 'idle'): void {
    this.status.textContent = text;
    this.status.dataset['tone'] = tone;
  }

  /**
   * Repaint the HUD from a label→value map.
   *
   * Rows are reused rather than rebuilt: this runs every animation frame, and
   * replacing the subtree 60 times a second is a measurable amount of layout
   * work for something whose only job is to display numbers.
   */
  setHud(rows: ReadonlyArray<readonly [label: string, value: string, tone?: StatusTone]>): void {
    while (this.hud.children.length > rows.length) this.hud.lastElementChild?.remove();
    while (this.hud.children.length < rows.length) {
      const row = el('div', 'hud-row');
      row.append(el('span', 'hud-label'), el('span', 'hud-value'));
      this.hud.append(row);
    }
    rows.forEach(([label, value, tone], i) => {
      const row = this.hud.children[i] as HTMLElement;
      const labelEl = row.firstElementChild as HTMLElement;
      const valueEl = row.lastElementChild as HTMLElement;
      if (labelEl.textContent !== label) labelEl.textContent = label;
      if (valueEl.textContent !== value) valueEl.textContent = value;
      const next = tone ?? 'idle';
      if (row.dataset['tone'] !== next) row.dataset['tone'] = next;
    });
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
