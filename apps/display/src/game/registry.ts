/**
 * Every game the display knows about.
 *
 * A plain array, on purpose. `docs/implementation-plan.md` §Phase 3c: the second
 * and third games are what reveal what actually wants to be shared, so anything
 * more structured than this before then is a guess.
 *
 * Order is menu order. The debug cursor sits first because every on-device
 * session starts by confirming the link and the pointing calibration.
 */

import type { GameModule } from './module.js';
import { debugCursor } from './games/debug-cursor.js';
import { flappy } from './games/flappy.js';
import { fruitSlash } from './games/fruit-slash.js';
import { starFighter } from './games/star-fighter.js';

export const GAMES: readonly GameModule[] = [debugCursor, flappy, fruitSlash, starFighter];

export function gameById(id: string): GameModule | undefined {
  return GAMES.find((g) => g.id === id);
}
