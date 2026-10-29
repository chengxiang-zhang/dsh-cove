/**
 * iOS does not have an update flow, and pretending otherwise is worse than skipping it.
 *
 * @format
 */

import {Platform} from 'react-native';

import {checkForUpdate, updateFlowApplies} from '../src/updater';

test('the channel update flow does not apply to iOS', () => {
  expect(updateFlowApplies('ios')).toBe(false);
  expect(updateFlowApplies('android')).toBe(true);
});

test('a check on iOS answers "nothing to do" instead of offering an APK', async () => {
  const previous = Platform.OS;
  Platform.OS = 'ios';
  try {
    // No channel is read at all: the answer does not depend on the network.
    const found = await checkForUpdate();
    expect(found).toBeNull();
  } finally {
    Platform.OS = previous;
  }
});
