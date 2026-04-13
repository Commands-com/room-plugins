import test from 'node:test';
import assert from 'node:assert/strict';

import breakRoomDescriptor, {
  createPlugin as createBreakRoomPlugin,
  manifest as breakRoomManifest,
} from '../room-plugins/break-room/index.js';
import reviewCycleDescriptor, {
  createPlugin as createReviewCyclePlugin,
  manifest as reviewCycleManifest,
} from '../room-plugins/review-cycle/index.js';
import warRoomDescriptor, {
  createPlugin as createWarRoomPlugin,
  manifest as warRoomManifest,
} from '../room-plugins/war-room/index.js';
import uiUxTestingDescriptor, {
  createPlugin as createUiUxTestingPlugin,
  manifest as uiUxTestingManifest,
} from '../room-plugins/ui-ux-testing/index.js';

function assertPluginShape(plugin) {
  assert.equal(typeof plugin.init, 'function');
  assert.equal(typeof plugin.onRoomStart, 'function');
  assert.equal(typeof plugin.onTurnResult, 'function');
  assert.equal(typeof plugin.onFanOutComplete, 'function');
  assert.equal(typeof plugin.onEvent, 'function');
  assert.equal(typeof plugin.shutdown, 'function');
}

test('ported core room descriptors export manifest + createPlugin for classic rooms', () => {
  const cases = [
    [breakRoomDescriptor, breakRoomManifest, createBreakRoomPlugin, 'break_room'],
    [reviewCycleDescriptor, reviewCycleManifest, createReviewCyclePlugin, 'review_cycle'],
    [warRoomDescriptor, warRoomManifest, createWarRoomPlugin, 'war_room'],
    [uiUxTestingDescriptor, uiUxTestingManifest, createUiUxTestingPlugin, 'ui_ux_testing'],
  ];

  for (const [descriptor, manifest, createPlugin, orchestratorType] of cases) {
    assert.equal(descriptor.manifest.orchestratorType, orchestratorType);
    assert.deepEqual(descriptor.manifest, manifest);
    assert.equal(typeof descriptor.createPlugin, 'function');
    assert.equal(typeof createPlugin, 'function');

    const plugin = createPlugin();
    assertPluginShape(plugin);
  }
});

test('ui-ux-testing descriptor keeps compatibility hooks at descriptor level', () => {
  assert.equal(typeof uiUxTestingDescriptor.checkCompatibility, 'function');
  assert.equal(typeof uiUxTestingDescriptor.makeCompatible, 'function');
});
