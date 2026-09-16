import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { createCameraFocus } from './camera_focus.js';

test('focus eases camera and orbit target while preserving their offset', () => {
  let time = 0;
  const camera = { position: new THREE.Vector3(10, 0, 0) };
  const controls = {
    target: new THREE.Vector3(),
    addEventListener() {},
  };
  const focus = createCameraFocus(camera, controls, { duration: 1000, now: () => time });
  const destination = new THREE.Vector3(20, 4, -2);

  focus.start(destination);
  time = 500;
  assert.equal(focus.update(), true);
  assert.deepEqual(controls.target.toArray(), [10, 2, -1]);
  assert.deepEqual(camera.position.toArray(), [20, 2, -1]);

  time = 1000;
  focus.update();
  assert.deepEqual(controls.target.toArray(), destination.toArray());
  assert.deepEqual(camera.position.toArray(), [30, 4, -2]);
});
