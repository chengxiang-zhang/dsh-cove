import test from 'node:test';
import assert from 'node:assert/strict';

import { contentRect, isCovering, sameRect } from '../src/view-geometry.mjs';

// The page area of the default window: tab strip 44px tall, 1000x760 content.
const WINDOW = { width: 1000, height: 760 };
const PAGE = { x: 0, y: 44, width: 1000, height: 716 };

test('at 100% zoom the reported rect is the placement', () => {
  assert.deepEqual(contentRect({ rect: PAGE, zoom: 1, content: WINDOW }), PAGE);
});

test('a zoomed shell reports CSS pixels, and the placement is DIP', () => {
  // At 125% the renderer's viewport is 800 CSS pixels wide for 1000 DIP, so the page
  // area it measures is 800 CSS wide and must be placed 1000 DIP wide. Without the
  // conversion the page covers four fifths of the window on every resize and zoom.
  const zoomed = { x: 0, y: 35, width: 800, height: 573 };
  assert.deepEqual(contentRect({ rect: zoomed, zoom: 1.25, content: WINDOW }), {
    x: 0,
    y: 44,
    width: 1000,
    height: 716,
  });
});

test('zooming out scales the other way', () => {
  const zoomedOut = { x: 0, y: 55, width: 1250, height: 895 };
  assert.deepEqual(contentRect({ rect: zoomedOut, zoom: 0.8, content: WINDOW }), {
    x: 0,
    y: 44,
    width: 1000,
    height: 716,
  });
});

test('a rect wider than the window is clamped instead of painting over the edge', () => {
  // The frame after the window shrinks, before the renderer caught up.
  const stale = { x: 0, y: 44, width: 1200, height: 900 };
  assert.deepEqual(contentRect({ rect: stale, zoom: 1, content: WINDOW }), WINDOW_PAGE(WINDOW));
});

test('an offset page area is clamped against what is left, not against the window', () => {
  const rect = contentRect({ rect: { x: 20, y: 60, width: 5000, height: 5000 }, zoom: 1, content: WINDOW });
  assert.deepEqual(rect, { x: 20, y: 60, width: 980, height: 700 });
});

test('unusable measurements collapse to nothing rather than spreading NaN', () => {
  assert.deepEqual(contentRect({ rect: { x: NaN, y: undefined, width: null, height: 'x' }, zoom: 1, content: WINDOW }), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  assert.equal(isCovering(contentRect({ rect: null, zoom: 1, content: WINDOW })), false);
});

test('an unusable zoom is treated as 100% rather than as a reason not to draw', () => {
  assert.deepEqual(contentRect({ rect: PAGE, zoom: 0, content: WINDOW }), PAGE);
  assert.deepEqual(contentRect({ rect: PAGE, zoom: Number.NaN, content: WINDOW }), PAGE);
});

test('the same placement is recognised across a zoom that does not move it', () => {
  const a = contentRect({ rect: PAGE, zoom: 1, content: WINDOW });
  const b = contentRect({ rect: { x: 0, y: 22, width: 500, height: 358 }, zoom: 2, content: WINDOW });
  assert.equal(sameRect(a, b), true);
  assert.equal(sameRect(a, { ...a, width: a.width - 1 }), false);
  assert.equal(sameRect(null, null), true);
  assert.equal(sameRect(a, null), false);
});

function WINDOW_PAGE(window) {
  return { x: 0, y: 44, width: window.width, height: window.height - 44 };
}
