import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SceneManager, SceneTransitionError, canTransition } from '../dist/index.js';

function traced(name, log) {
  return {
    name,
    enter: (from) => log.push(`${name}:enter(${from})`),
    exit: (to) => log.push(`${name}:exit(${to})`),
    update: () => log.push(`${name}:update`),
    render: () => log.push(`${name}:render`),
  };
}

function makeManager(log = []) {
  const names = ['menu', 'pairing', 'lobby', 'play', 'results'];
  return { mgr: new SceneManager(names.map((n) => traced(n, log))), log };
}

test('start enters the first scene', () => {
  const { mgr, log } = makeManager();
  mgr.start('menu');
  assert.equal(mgr.current, 'menu');
  assert.deepEqual(log, ['menu:enter(null)']);
});

test('the full happy path runs end to end', () => {
  const { mgr } = makeManager();
  mgr.start('menu');
  for (const next of ['pairing', 'lobby', 'play', 'results']) mgr.goTo(next);
  assert.equal(mgr.current, 'results');
  assert.deepEqual(mgr.history, ['menu', 'pairing', 'lobby', 'play', 'results']);
});

test('exit runs fully before enter', () => {
  const { mgr, log } = makeManager();
  mgr.start('menu');
  log.length = 0;
  mgr.goTo('pairing');
  // Ordering matters: a scene tearing down must never observe the manager
  // already pointing at its successor.
  assert.deepEqual(log, ['menu:exit(pairing)', 'pairing:enter(menu)']);
});

test('an illegal transition throws rather than silently rendering the wrong scene', () => {
  const { mgr } = makeManager();
  mgr.start('menu');
  mgr.goTo('pairing');
  mgr.goTo('lobby');
  mgr.goTo('play');

  // A late `join` arriving after the match started must not drag the display
  // back into pairing.
  assert.throws(() => mgr.goTo('pairing'), SceneTransitionError);
  assert.equal(mgr.current, 'play', 'a rejected transition leaves state untouched');
});

test('tryGoTo reports failure instead of throwing', () => {
  const { mgr } = makeManager();
  mgr.start('menu');
  assert.equal(mgr.tryGoTo('play'), false, 'menu → play is not a legal move');
  assert.equal(mgr.current, 'menu');
  assert.equal(mgr.tryGoTo('pairing'), true);
  assert.equal(mgr.current, 'pairing');
});

test('re-entering the current scene is a no-op', () => {
  const { mgr, log } = makeManager();
  mgr.start('menu');
  log.length = 0;
  mgr.goTo('menu');
  assert.deepEqual(log, [], 'no spurious exit/enter pair');
});

test('update and render reach only the current scene', () => {
  const { mgr, log } = makeManager();
  mgr.start('menu');
  mgr.goTo('pairing');
  log.length = 0;

  mgr.update(1 / 60, 100);
  mgr.render(0.5);

  assert.deepEqual(log, ['pairing:update', 'pairing:render']);
});

test('players can back out of pairing and lobby, but not out of a match', () => {
  assert.ok(canTransition('pairing', 'menu'));
  assert.ok(canTransition('lobby', 'pairing'));
  // Dropping a controller mid-match should surface a reconnect prompt, not
  // silently abandon the game.
  assert.ok(!canTransition('play', 'pairing'));
  assert.ok(canTransition('play', 'results'));
  assert.ok(canTransition('results', 'lobby'), 'rematch without re-pairing');
});

test('an unregistered scene fails loudly', () => {
  const mgr = new SceneManager([]);
  assert.throws(() => mgr.start('menu'), /scene not registered/);
});

test('scenes need not implement every hook', () => {
  const mgr = new SceneManager([{ name: 'menu' }, { name: 'pairing' }]);
  mgr.start('menu');
  assert.doesNotThrow(() => {
    mgr.update(1 / 60, 0);
    mgr.render(0);
    mgr.goTo('pairing');
  });
});
