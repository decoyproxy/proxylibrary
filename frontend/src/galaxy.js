import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

// Saturated on white, not neon on black: these have to hold up as ink.
const TYPE_COLOR = {
  Project: 0xb45309,
  Concept: 0x0f766e,
  Source: 0x4338ca,
  Fragment: 0xbe185d,
  Asset: 0x15803d,
};
const EDGE_COLOR = { SPARK: 0xbe185d, RESEARCH: 0x0f766e, ASSEMBLE: 0xb45309 };
const PAPER = 0xffffff;
const TRANSITION_MS = 900;
const GROW_MS = 320; // a node scaling up as it enters the timeline

// Shared across every node mesh; per-node size comes from mesh.scale.
const SPHERE = new THREE.SphereGeometry(1, 16, 12);
const PLANE = new THREE.PlaneGeometry(1, 1);
const TEXTURES = new THREE.TextureLoader();
const THUMB_SCALE = 3.4; // a thumbnail reads at roughly 3.4x the radius of a dot

export function createGalaxy(canvas, graph, onSelect) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAPER);
  scene.fog = new THREE.FogExp2(PAPER, 0.001); // density re-tuned per view in frameAll

  const camera = new THREE.PerspectiveCamera(55, 1, 1, 4000);
  camera.position.set(180, 120, 240);

  // preserveDrawingBuffer keeps the frame readable after it is composited,
  // which is what makes Capture able to hand back a PNG at all.
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.cssText = 'position:fixed;inset:0;pointer-events:none';
  document.body.append(labelRenderer.domElement);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;

  scene.add(new THREE.AmbientLight(0xffffff, 2.2));
  const key = new THREE.PointLight(0xffffff, 1.2, 0, 0);
  key.position.set(200, 300, 200);
  scene.add(key);

  const byId = new Map();
  const billboards = []; // thumbnails are flat, so they must face the camera
  const labelled = new Set();

  // Only the important nodes are labelled — and an edit can change that, so
  // this both creates and removes.
  function labelFor(mesh) {
    const node = mesh.userData.node;
    const wanted = node.importance >= 4;
    if (wanted && !mesh.userData.label) {
      const el = document.createElement('div');
      el.className = 'label';
      const label = new CSS2DObject(el);
      mesh.add(label);
      mesh.userData.label = label;
      labelled.add(mesh);
    } else if (!wanted && mesh.userData.label) {
      mesh.remove(mesh.userData.label);
      mesh.userData.label.element.remove();
      mesh.userData.label = null;
      mesh.userData.size = null;
      labelled.delete(mesh);
    }
    const label = mesh.userData.label;
    if (!label) return;
    label.element.textContent = node.title;
    mesh.userData.size = null; // re-measure: the text may have changed width
    // The label is a child of a mesh scaled by `size`, so a local offset is
    // multiplied by it — a plain `size + 3` put the label size-times too far
    // above its node. Divide it back out to sit 3 units clear of the surface.
    const size = 1.6 + node.importance * 1.3;
    label.position.y = (size + 3) / (mesh.userData.restScale?.y ?? size);
  }

  function dot(node) {
    return new THREE.Mesh(
      SPHERE,
      new THREE.MeshStandardMaterial({
        color: TYPE_COLOR[node.type] ?? 0xffffff,
        emissive: TYPE_COLOR[node.type] ?? 0xffffff,
        emissiveIntensity: 0,
        roughness: 0.45,
        transparent: true,
      }),
    );
  }

  // Image nodes render as their own picture. The texture arrives later, so the
  // plane starts square and takes the file's aspect ratio once it has loaded.
  function thumbnail(node, size) {
    const material = new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false });
    const mesh = new THREE.Mesh(PLANE, material);
    // A dark photograph on a dark background has no edge; this card gives it one.
    const card = new THREE.Mesh(
      PLANE,
      new THREE.MeshBasicMaterial({ color: 0xc9c9c9, transparent: true }),
    );
    card.scale.set(1.06, 1.06, 1);
    card.position.z = -0.01;
    card.raycast = () => {}; // the picture takes the clicks, not its frame
    mesh.add(card);
    TEXTURES.load(
      `/media/${node.path}`,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        material.map = texture;
        material.needsUpdate = true;
        const { width, height } = texture.image;
        mesh.scale.set(size * THUMB_SCALE * (width / height), size * THUMB_SCALE, 1);
        mesh.userData.restScale = mesh.scale.clone();
      },
      undefined,
      () => {
        // Missing file: fall back to a plain dot rather than an invisible node.
        material.color.set(TYPE_COLOR[node.type] ?? 0xffffff);
      },
    );
    material.color.setScalar(0.9);
    billboards.push(mesh);
    return mesh;
  }

  function build(node) {
    const size = 1.6 + node.importance * 1.3;
    const isImage = node.media === 'image';
    const mesh = isImage ? thumbnail(node, size) : dot(node);
    if (isImage) mesh.scale.set(size * THUMB_SCALE, size * THUMB_SCALE, 1);
    else mesh.scale.setScalar(size);
    mesh.userData.restScale = mesh.scale.clone();
    mesh.userData.node = node;
    labelFor(mesh);
    scene.add(mesh);
    byId.set(node.id, mesh);
    return mesh;
  }

  for (const node of graph.nodes) build(node);


  // A line's thickness comes from its material, so lines of different thickness
  // cannot share one: edges are drawn in four weight bands. WebGL's own
  // `linewidth` is ignored on nearly every platform, which is why these are
  // LineMaterial (screen-space quads) rather than LineBasicMaterial.
  const BANDS = [
    { width: 0.9, opacity: 0.18 },
    { width: 1.7, opacity: 0.3 },
    { width: 2.7, opacity: 0.44 },
    { width: 3.8, opacity: 0.62 },
  ].map((band) => {
    const material = new LineMaterial({
      vertexColors: true, transparent: true, worldUnits: false,
      linewidth: band.width, opacity: band.opacity,
    });
    material.resolution.set(innerWidth, innerHeight);
    const object = new LineSegments2(new LineSegmentsGeometry(), material);
    object.frustumCulled = false; // the positions move without the bounds following
    scene.add(object);
    return { ...band, material, object, all: [], edges: [], positions: new Float32Array(0) };
  });

  let edges = [];
  let relations = new Set(Object.keys(EDGE_COLOR));

  // Editing a relation changes how many segments there are, so the buffers are
  // rebuilt rather than rewritten. The old geometry is disposed — a galaxy the
  // reader keeps rewiring would otherwise leak one buffer per edit.
  function setEdges(next) {
    edges = next.filter((edge) => byId.has(edge.source) && byId.has(edge.target));

    // Similarities occupy a narrow band of their own — 0.46 to 0.85 in this
    // library — so they are spread across the range the edges actually use.
    // Against an absolute 0..1 scale every line would look alike.
    const weights = edges.map((edge) => edge.weight ?? 0.5);
    const low = Math.min(...weights, 1);
    const span = Math.max(Math.max(...weights, 0) - low, 1e-6);

    for (const band of BANDS) band.all = [];
    edges.forEach((edge, i) => {
      const place = (weights[i] - low) / span;
      BANDS[Math.min(Math.floor(place * BANDS.length), BANDS.length - 1)].all.push(edge);
    });
    rebuildEdges();
  }

  // Hidden edges are left out of the geometry rather than folded to zero
  // length. Folding was free with LineBasicMaterial, but a screen-space quad
  // needs a direction to extrude along; a zero-length segment gives it NaNs,
  // which LineMaterial draws as a black slab across the middle of the galaxy.
  function rebuildEdges() {
    for (const band of BANDS) {
      band.edges = band.all.filter((edge) =>
        byId.get(edge.source)?.visible && byId.get(edge.target)?.visible &&
        relations.has(edge.type));
      band.positions = new Float32Array(band.edges.length * 6);
      const colours = new Float32Array(band.edges.length * 6);
      band.edges.forEach((edge, i) => {
        const colour = new THREE.Color(EDGE_COLOR[edge.type] ?? 0x555566);
        for (let end = 0; end < 2; end++) colour.toArray(colours, i * 6 + end * 3);
      });
      band.object.geometry.dispose();
      band.object.geometry = new LineSegmentsGeometry();
      band.object.geometry.setPositions(band.positions);
      band.object.geometry.setColors(colours);
      band.object.visible = band.edges.length > 0;
    }
    updateEdges();
  }

  // View transition: every mesh lerps from where it is to the new view's coordinates.
  let from = new Map();
  let to = new Map();
  let startedAt = -Infinity;

  let currentView = 'semantic';

  function setView(view) {
    currentView = view;
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
    // Fit by whichever field of view is narrower: on a tall window the
    // horizontal one is, and fitting by height alone cuts the sides off.
    const vertical = (camera.fov * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
    const distance = (sphere.radius * 1.15) / Math.sin(Math.min(vertical, horizontal) / 2);
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
    for (const band of BANDS) {
      const instances = band.object.geometry.attributes.instanceStart;
      if (!band.edges.length || !instances) continue;
      band.edges.forEach((edge, i) => {
        byId.get(edge.source).position.toArray(band.positions, i * 6);
        byId.get(edge.target).position.toArray(band.positions, i * 6 + 3);
      });
      // Written straight into the instanced buffer: setPositions allocates new
      // ones, and this runs on every frame of a view transition.
      instances.data.array.set(band.positions);
      instances.data.needsUpdate = true;
    }
  }

  // Lit dots brighten; thumbnails, which are unlit, get a white tint instead.
  function setSelected(mesh, on) {
    if (!mesh) return;
    if ('emissiveIntensity' in mesh.material) mesh.material.emissiveIntensity = on ? 0.9 : 0;
    else mesh.material.color.setScalar(on ? 1 : 0.9);
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const chosen = new Set(); // every selected mesh, one or many
  let onSelectionChange = () => {};

  function selection() {
    return [...chosen].map((mesh) => mesh.userData.node);
  }

  function choose(meshes, { add = false } = {}) {
    if (!add) {
      for (const mesh of chosen) setSelected(mesh, false);
      chosen.clear();
    }
    for (const mesh of meshes) {
      if (chosen.has(mesh)) {
        chosen.delete(mesh);
        setSelected(mesh, false);
      } else {
        chosen.add(mesh);
        setSelected(mesh, true);
      }
    }
    const nodes = selection();
    onSelect(nodes.length === 1 ? nodes[0] : null);
    onSelectionChange(nodes);
  }

  function clearSelection() {
    choose([]);
  }

  function pick(event) {
    pointer.set(
      (event.clientX / innerWidth) * 2 - 1,
      -(event.clientY / innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(
      [...byId.values()].filter((mesh) => mesh.visible), false)[0]?.object ?? null;
  }

  // Shift starts a rubber band; a shift-click that never moves is a plain
  // add-to-selection. Orbiting is suspended in between, or the camera would
  // swing around while you are drawing the box.
  const band = document.createElement('div');
  band.className = 'band';
  band.hidden = true;
  document.body.append(band);
  let bandStart = null;

  canvas.addEventListener('pointerdown', (event) => {
    if (event.shiftKey) {
      bandStart = { x: event.clientX, y: event.clientY };
      controls.enabled = false;
      return;
    }
    const hit = pick(event);
    choose(hit ? [hit] : []);
  });

  addEventListener('pointermove', (event) => {
    if (!bandStart) return;
    const left = Math.min(bandStart.x, event.clientX);
    const top = Math.min(bandStart.y, event.clientY);
    band.style.left = `${left}px`;
    band.style.top = `${top}px`;
    band.style.width = `${Math.abs(event.clientX - bandStart.x)}px`;
    band.style.height = `${Math.abs(event.clientY - bandStart.y)}px`;
    band.hidden = false;
  });

  addEventListener('pointerup', (event) => {
    if (!bandStart) return;
    const box = {
      left: Math.min(bandStart.x, event.clientX),
      right: Math.max(bandStart.x, event.clientX),
      top: Math.min(bandStart.y, event.clientY),
      bottom: Math.max(bandStart.y, event.clientY),
    };
    const dragged = box.right - box.left > 4 || box.bottom - box.top > 4;
    bandStart = null;
    band.hidden = true;
    controls.enabled = true;

    if (!dragged) {
      const hit = pick(event);
      return choose(hit ? [hit] : [], { add: true });
    }
    const inside = [...byId.values()].filter((mesh) => {
      if (!mesh.visible) return false;
      const point = mesh.position.clone().project(camera);
      if (point.z > 1) return false;
      const x = (point.x * 0.5 + 0.5) * renderer.domElement.clientWidth;
      const y = (-point.y * 0.5 + 0.5) * renderer.domElement.clientHeight;
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    });
    choose(inside, { add: true });
  });


  // Search results. `dim` keeps the rest of the galaxy visible but faded, so a
  // search reads as "these ones, in context"; `only` makes the search a filter
  // like the others, which is what the export follows. null clears it.
  function highlight(ids, { only = false } = {}) {
    for (const [id, mesh] of byId) {
      const missed = ids !== null && !ids.has(id);
      mesh.material.opacity = missed ? 0.12 : 1;
      mesh.userData.dimmed = missed;
      mesh.userData.searchOn = !only || !missed;
    }
    applyVisibility();
  }

  // A node written while the galaxy is open: it starts at nothing, in the place
  // its own words put it, and grows in.
  function addNode(node) {
    if (byId.has(node.id)) return updateNode(node);
    const mesh = build(node);
    const spot = node.coordinates[currentView];
    mesh.position.set(spot.x, spot.y, spot.z);
    mesh.scale.setScalar(0.001);
    mesh.userData.grownAt = performance.now();
    from.set(node.id, mesh.position.clone());
    to.set(node.id, mesh.position.clone());
    applyVisibility();
    return mesh;
  }

  // What is on screen right now, as data. The filters are the point of the
  // export: a view worth keeping is usually a subset.
  function visibleGraph() {
    const nodes = [...byId.values()].filter((mesh) => mesh.visible);
    const shown = new Set(nodes.map((mesh) => mesh.userData.node.id));
    return {
      view: currentView,
      nodes: nodes.map((mesh) => ({
        ...mesh.userData.node,
        position: mesh.position.toArray().map((value) => Math.round(value * 10) / 10),
      })),
      edges: edges.filter((edge) =>
        shown.has(edge.source) && shown.has(edge.target) && relations.has(edge.type)),
    };
  }

  // The galaxy as a picture. Labels are DOM elements, so they are drawn onto a
  // 2D canvas over the rendered frame — a capture without them would be a field
  // of dots nobody can read.
  function capture(scale = 2) {
    const width = renderer.domElement.clientWidth;
    const height = renderer.domElement.clientHeight;
    const previous = renderer.getPixelRatio();
    renderer.setPixelRatio(scale);
    renderer.setSize(width, height, false);
    renderer.render(scene, camera);

    const out = document.createElement('canvas');
    out.width = width * scale;
    out.height = height * scale;
    const context = out.getContext('2d');
    context.fillStyle = `#${new THREE.Color(PAPER).getHexString()}`;
    context.fillRect(0, 0, out.width, out.height);
    context.drawImage(renderer.domElement, 0, 0, out.width, out.height);

    context.font = `${11 * scale}px ui-monospace, Menlo, monospace`;
    context.textAlign = 'center';
    for (const mesh of labelled) {
      const element = mesh.userData.label.element;
      if (!mesh.visible || element.style.visibility === 'hidden') continue;
      const point = mesh.userData.label.position.clone();
      mesh.localToWorld(point).project(camera);
      if (point.z > 1) continue;
      context.fillStyle = `rgba(90, 90, 90, ${element.style.opacity || 1})`;
      context.fillText(
        element.textContent,
        (point.x * 0.5 + 0.5) * out.width,
        (-point.y * 0.5 + 0.5) * out.height,
      );
    }

    renderer.setPixelRatio(previous);
    renderer.setSize(width, height, false);
    return new Promise((done) => out.toBlob(done, 'image/png'));
  }

  // A deleted node shrinks away and then lets go of its GPU memory. The promise
  // resolves once it is gone, so the caller can rewire the edges after.
  function removeNode(id) {
    const mesh = byId.get(id);
    if (!mesh) return Promise.resolve();
    byId.delete(id);
    labelled.delete(mesh);
    chosen.delete(mesh);
    const index = billboards.indexOf(mesh);
    if (index >= 0) billboards.splice(index, 1);
    from.delete(id);
    to.delete(id);

    const start = performance.now();
    const rest = mesh.userData.restScale.clone();
    return new Promise((done) => {
      (function shrink(now) {
        const t = Math.min((now - start) / GROW_MS, 1);
        mesh.scale.copy(rest).multiplyScalar(1 - easeInOut(t));
        if (t < 1) return requestAnimationFrame(shrink);
        mesh.userData.label?.element.remove();
        scene.remove(mesh);
        mesh.material.map?.dispose();
        mesh.material.dispose();
        for (const child of mesh.children) child.material?.dispose();
        done();
      })(start);
    });
  }

  // An edited node: new size, new label, and a glide to wherever the change
  // moved it in the view on screen. Everything else stays where it is — the
  // `from` map is refreshed from current positions, so their lerp is a no-op.
  function updateNode(node) {
    const mesh = byId.get(node.id);
    if (!mesh) return;
    mesh.userData.node = node;
    const size = 1.6 + node.importance * 1.3;
    if (node.media === 'image') {
      const aspect = mesh.userData.restScale.x / mesh.userData.restScale.y;
      mesh.userData.restScale.set(size * THUMB_SCALE * aspect, size * THUMB_SCALE, 1);
    } else {
      mesh.userData.restScale.setScalar(size);
    }
    mesh.scale.copy(mesh.userData.restScale);
    labelFor(mesh);

    const spot = node.coordinates[currentView];
    from = new Map([...byId].map(([id, m]) => [id, m.position.clone()]));
    to.set(node.id, new THREE.Vector3(spot.x, spot.y, spot.z));
    startedAt = performance.now();
    placeLabels();
  }

  // Five independent filters decide what is drawn — type, domain, tags, search
  // and the timeline — so none may write mesh.visible directly or the last one
  // to run would undo the others.
  function applyVisibility() {
    for (const mesh of byId.values()) {
      const visible = mesh.userData.typeOn !== false &&
        mesh.userData.domainOn !== false &&
        mesh.userData.tagOn !== false &&
        mesh.userData.searchOn !== false &&
        mesh.userData.setOn !== false &&
        mesh.userData.timeOn !== false;
      if (visible && !mesh.visible) mesh.userData.grownAt = performance.now();
      mesh.visible = visible;
    }
    rebuildEdges();
    placeLabels();
  }

  // Type filter. `types` is a Set of the node types to show.
  function setTypes(types) {
    for (const mesh of byId.values()) {
      mesh.userData.typeOn = types.has(mesh.userData.node.type);
    }
    applyVisibility();
  }

  // Relation filter. Edges live in one buffer, so hiding a kind folds those
  // segments to zero length rather than rebuilding the geometry.
  function setRelations(kinds) {
    relations = kinds;
    rebuildEdges();
  }

  // Tag filter. Unlike the others this one starts off: an empty selection means
  // no constraint, and picking tags narrows to the nodes carrying any of them.
  // Show only these node ids (a saved selection), or everything when null.
  function setOnly(ids) {
    for (const [id, mesh] of byId) mesh.userData.setOn = ids === null || ids.has(id);
    applyVisibility();
  }

  function setTags(tags) {
    for (const mesh of byId.values()) {
      mesh.userData.tagOn =
        tags.size === 0 || (mesh.userData.node.tags ?? []).some((tag) => tags.has(tag));
    }
    applyVisibility();
  }

  // Domain filter, the same shape as the type one.
  function setDomains(domains) {
    for (const mesh of byId.values()) {
      mesh.userData.domainOn = domains.has(mesh.userData.node.domain);
    }
    applyVisibility();
  }

  // Timeline: show only what had been collected by `month` (YYYY-MM, or null
  // for all of it). Nodes appear as the scrubber moves forward, so the galaxy
  // assembles itself in the order the library actually grew.
  function setCutoff(month) {
    for (const mesh of byId.values()) {
      // Dates are YYYY-MM-DD and the cutoff is YYYY-MM: compared whole, any day
      // in the cutoff month would sort after it and vanish.
      mesh.userData.timeOn = month === null || (mesh.userData.node.date ?? '').slice(0, 7) <= month;
    }
    applyVisibility();
  }

  // Labels overlap badly in a dense galaxy, and a label nobody can read is
  // worse than none. Nearer and more important labels claim their screen box
  // first; whatever collides with an already-placed one steps aside.
  const LABEL_FADE = 2.2; // hide a label beyond this multiple of the orbit radius
  let labelFrame = 0;

  function placeLabels() {
    const taken = [];
    const width = renderer.domElement.clientWidth;
    const height = renderer.domElement.clientHeight;
    const reach = camera.position.distanceTo(controls.target) * LABEL_FADE;
    const ranked = [...labelled]
      .map((mesh) => ({ mesh, distance: camera.position.distanceTo(mesh.position) }))
      .sort((a, b) =>
        b.mesh.userData.node.importance - a.mesh.userData.node.importance ||
        a.distance - b.distance);

    for (const { mesh, distance } of ranked) {
      const element = mesh.userData.label.element;
      const faded = mesh.userData.dimmed ? 0.18 : 1 - Math.min(distance / reach, 1) * 0.75;
      if (!mesh.visible || distance > reach) {
        element.style.visibility = 'hidden';
        continue;
      }
      const point = mesh.position.clone().project(camera);
      const x = (point.x * 0.5 + 0.5) * width;
      const y = (-point.y * 0.5 + 0.5) * height;
      // Measured once the element has actually been laid out — before that
      // offsetWidth is 0, and caching that zero would shrink every box to
      // nothing and defeat the collision test. The text never changes, so one
      // good measurement is enough; reading it every frame would force a layout.
      if (!mesh.userData.size?.w) {
        const measured = { w: element.offsetWidth, h: element.offsetHeight };
        if (measured.w) mesh.userData.size = measured;
      }
      const { w, h } = mesh.userData.size ?? { w: 90, h: 14 };
      const box = { left: x - w / 2, right: x + w / 2, top: y - h, bottom: y };
      const clash = taken.some((other) =>
        box.left < other.right && box.right > other.left &&
        box.top < other.bottom && box.bottom > other.top);
      if (clash || point.z > 1) {
        element.style.visibility = 'hidden';
        continue;
      }
      taken.push(box);
      element.style.visibility = 'visible';
      element.style.opacity = faded;
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

  let emptyDoubleClick = () => {};
  function onEmptyDoubleClick(handler) {
    emptyDoubleClick = handler;
  }

  canvas.addEventListener('dblclick', (event) => {
    pointer.set(
      (event.clientX / innerWidth) * 2 - 1,
      -(event.clientY / innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const visible = [...byId.values()].filter((mesh) => mesh.visible);
    if (!raycaster.intersectObjects(visible, false).length) emptyDoubleClick();
  });

  function resize() {
    const { clientWidth: w, clientHeight: h } = document.documentElement;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    labelRenderer.setSize(w, h);
    for (const band of BANDS) band.material.resolution.set(w, h);
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
    for (const mesh of byId.values()) {
      const since = now - (mesh.userData.grownAt ?? -Infinity);
      if (since >= 0 && since <= GROW_MS) {
        mesh.scale.copy(mesh.userData.restScale).multiplyScalar(easeInOut(since / GROW_MS));
      } else if (mesh.userData.grownAt && since > GROW_MS) {
        mesh.scale.copy(mesh.userData.restScale);
        mesh.userData.grownAt = null;
      }
    }
    for (const mesh of billboards) mesh.quaternion.copy(camera.quaternion);
    if (++labelFrame % 5 === 0) placeLabels();
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  setEdges(graph.edges); // before the first frame: the loop updates this geometry
  requestAnimationFrame(frame);

  return {
    setView, focus, highlight, setTypes, setDomains, setTags, setOnly, setCutoff, updateNode,
    setEdges, addNode, removeNode, onEmptyDoubleClick, setRelations,
    visibleGraph, capture, selection, clearSelection,
    onSelectionChange: (handler) => { onSelectionChange = handler; },
    relationColors: EDGE_COLOR,
    typeColors: TYPE_COLOR,
  };
}
