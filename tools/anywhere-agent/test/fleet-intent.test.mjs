import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fleetWanted, withFleetIntent } from '../src/fleet-intent.mjs';

test('only a remembered request brings the network back', () => {
  // The ordinary launch is a single-machine launch: an absent or older settings file must
  // never start a dial-up on someone who never asked for one.
  assert.equal(fleetWanted(undefined), false);
  assert.equal(fleetWanted(null), false);
  assert.equal(fleetWanted({}), false);
  assert.equal(fleetWanted({ scheme: 'dark' }), false);
  assert.equal(fleetWanted({ fleetWanted: false }), false);
  assert.equal(fleetWanted({ fleetWanted: 'true' }), false, 'a string is not a choice');
  assert.equal(fleetWanted({ fleetWanted: 1 }), false, 'a number is not a choice');
  assert.equal(fleetWanted({ fleetWanted: true }), true);
});

test('recording the choice leaves the rest of the settings alone', () => {
  // Signing in once must not cost someone their theme or the server they typed.
  const stored = { scheme: 'dark', server: { url: 'https://netbird.example:443' } };
  assert.deepEqual(withFleetIntent(stored, true), {
    scheme: 'dark',
    server: { url: 'https://netbird.example:443' },
    fleetWanted: true,
  });
  assert.deepEqual(withFleetIntent(stored, false).scheme, 'dark');
  assert.equal(withFleetIntent({}, true).fleetWanted, true);
  assert.equal(withFleetIntent(null, true).fleetWanted, true);
  assert.equal(withFleetIntent({ fleetWanted: true }, false).fleetWanted, false);
});
