import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const TYPE_COLOR = {
  Project: 0xffd25e,
  Concept: 0x6ee7ff,
  Source: 0xa78bfa,
  Fragment: 0xf472b6,
  Asset: 0x7dd88f,
};
const EDGE_COLOR = { SPARK: 0xf472b6, RESEARCH: 0x6ee7ff, ASSEMBLE: 0xffd25e };
const TRANSITION_MS = 900;

// Shared across every node mesh; per-node size comes from mesh.scale.
const SPHERE = new THREE.SphereGeometry(1, 16, 12);

export function createGalaxy(canvas, graph, onSelect) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05060a, 0.001); // density re-tuned per view in frameAll

  const camera = new THREE.PerspectiveCamera(55, 1, 1, 4000);
  camera.position.set(180, 120, 240);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.cssText = 'position:fixed;inset:0;pointer-events:none';
  document.body.append(labelRenderer.domElement);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;

  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const key = new THREE.PointLight(0xffffff, 1.6, 0, 0);
  key.position.set(200, 300, 200);
  scene.add(key);

  const byId = new Map();
  for (const node of graph.nodes) {
    const mesh = new THREE.Mesh(
      SPHERE,
      new THREE.MeshStandardMaterial({
        color: TYPE_COLOR[node.type] ?? 0xffffff,
        emissive: TYPE_COLOR[node.type] ?? 0xffffff,
        emissiveIntensity: 0.5,
        roughness: 0.4,
        transparent: true,
      }),
    );
    const size = 1.6 + node.importance * 1.3;
    mesh.scale.setScalar(size);
    mesh.userData.node = node;
    if (node.importance >= 4) {
      const el = document.createElement('div');
      el.className = 'label';
      el.textContent = node.title;
      const label = new CSS2DObject(el);
      label.position.y = size + 3;
      mesh.add(label);
    }
    scene.add(mesh);
    byId.set(node.id, mesh);
  }

  const edges = graph.edges.filter((e) => byId.has(e.source) && byId.has(e.target));
  const positions = new Float32Array(edges.length * 6);
  const colors = new Float32Array(edges.length * 6);
  edges.forEach((edge, i) => {
    const c = new THREE.Color(EDGE_COLOR[edge.type] ?? 0x555566);
    for (let end = 0; end < 2; end++) c.toArray(colors, i * 6 + end * 3);
  });
  const edgeGeom = new THREE.BufferGeometry();
  edgeGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  edgeGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  scene.add(
    new THREE.LineSegments(
      edgeGeom,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35 }),
    ),
  );

  // View transition: every mesh lerps from where it is to the new view's coordinates.
  let from = new Map();
  let to = new Map();
  let startedAt = -Infinity;

  function setView(view) {
    from = new Map([...byId].map(([id, mesh]) => [id, mesh.position.clone()]));
    to = new Map(
      graph.nodes.map((n) => {
        const c = n.coordinates[view];
        return [n.id, new THREE.Vector3(c.x, c.y, c.z)];
      }),
    );
    startedAt = performance.now();
    frameAll([...to.values()]);
  }

  // Pull the camera back far enough that the whole view fits, keeping its angle.
  function frameAll(points) {
    const box = new THREE.Box3().setFromPoints(points);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const distance = (sphere.radius * 1.15) / Math.sin((camera.fov * Math.PI) / 360);
    const direction = camera.position.clone().sub(controls.target).normalize();
    scene.fog.density = 0.7 / (distance + sphere.radius);
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    controls.update();
  }

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  }

  function updateEdges() {
    edges.forEach((edge, i) => {
      byId.get(edge.source).position.toArray(positions, i * 6);
      byId.get(edge.target).position.toArray(positions, i * 6 + 3);
    });
    edgeGeom.attributes.position.needsUpdate = true;
    edgeGeom.computeBoundingSphere();
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let selected = null;

  canvas.addEventListener('pointerdown', (event) => {
    pointer.set(
      (event.clientX / innerWidth) * 2 - 1,
      -(event.clientY / innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects([...byId.values()], false)[0];
    if (selected) selected.material.emissiveIntensity = 0.5;
    selected = hit?.object ?? null;
    if (selected) selected.material.emissiveIntensity = 1.6;
    onSelect(selected?.userData.node ?? null);
  });

  // Search highlight: dim everything that did not match. null clears it.
  function highlight(ids) {
    for (const [id, mesh] of byId) {
      const dim = ids !== null && !ids.has(id);
      mesh.material.opacity = dim ? 0.08 : 1;
      const label = mesh.children[0];
      if (label) label.element.style.opacity = dim ? 0.15 : 1;
    }
  }

  // Re-centre the orbit on one node, keeping both the angle and the distance.
  // Diving closer just buries the camera inside the cloud, where unrelated
  // nodes fill the screen.
  function focus(id) {
    const mesh = byId.get(id);
    if (!mesh) return;
    const offset = camera.position.clone().sub(controls.target);
    controls.target.copy(mesh.position);
    camera.position.copy(mesh.position).add(offset);
    controls.update();
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = document.documentElement;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    labelRenderer.setSize(w, h);
  }
  addEventListener('resize', resize);
  resize();

  function frame(now) {
    const t = Math.min((now - startedAt) / TRANSITION_MS, 1);
    if (t <= 1) {
      const k = easeInOut(t);
      for (const [id, mesh] of byId) mesh.position.lerpVectors(from.get(id), to.get(id), k);
      updateEdges();
    }
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return { setView, focus, highlight, typeColors: TYPE_COLOR };
}
