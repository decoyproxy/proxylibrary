/** Smoothly re-centre OrbitControls without changing viewing angle or distance. */
export function createCameraFocus(
  camera, controls, { duration = 700, now = () => performance.now() } = {},
) {
  let active = null;
  const cameraTo = camera.position.clone();

  function cancel() {
    active = null;
  }

  function start(destination) {
    const resolve = typeof destination === 'function' ? destination : () => destination;
    active = {
      started: now(),
      resolve,
      cameraFrom: camera.position.clone(),
      targetFrom: controls.target.clone(),
      offset: camera.position.clone().sub(controls.target),
    };
  }

  function update(time = now()) {
    if (!active) return false;
    const destination = active.resolve();
    if (!destination) {
      cancel();
      return false;
    }
    const t = Math.min(Math.max((time - active.started) / Math.max(duration, 1), 0), 1);
    const eased = t * t * (3 - 2 * t);
    controls.target.lerpVectors(active.targetFrom, destination, eased);
    cameraTo.copy(destination).add(active.offset);
    camera.position.lerpVectors(active.cameraFrom, cameraTo, eased);
    if (t === 1) cancel();
    return true;
  }

  controls.addEventListener('start', cancel);
  return { start, update, cancel };
}
