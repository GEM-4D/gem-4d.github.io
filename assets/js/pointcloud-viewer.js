/* ============================================================================
   Interactive point-cloud rollout viewer.

   The 34 rollout frames are never shipped as point clouds. They ship as two
   atlas textures -- a depth atlas (16-bit depth packed into the R and G bytes)
   and an RGB atlas -- and the vertex shader back-projects them with the capture
   intrinsics. One static grid of W*H vertices serves every frame, so advancing a
   frame costs a single uniform.

   Two clocks, on purpose:
     * the clip plays at `meta.fps` (8), one frame every 125 ms;
     * the camera and the controls run at the display rate, so dragging stays
       smooth at 60 Hz even though the geometry steps at 8 fps.

   The scripted camera sweeps -sweepDeg -> +sweepDeg across exactly one pass
   through the clip: 90 degrees of orbit is one complete task execution. The next
   pass sweeps back, so every pass is a whole execution and the seam never jumps.

   Dragging takes over the camera; after `resumeDelayMs` of no input the sweep
   eases back in from wherever it was left. Wheel zoom needs a modifier so the
   page can still be scrolled with the pointer over the viewer.
   ============================================================================ */

import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';

const VERT = /* glsl */`
  uniform sampler2D uDepth;
  uniform sampler2D uColor;
  uniform vec2  uGrid;        // atlas columns, rows
  uniform vec2  uSize;        // frame width, height in pixels
  uniform vec4  uK;           // fx, fy, cx, cy
  uniform vec2  uRange;       // depthMin, depthMax
  uniform float uFrame;       // current frame index
  uniform float uSizeK;       // (viewport height / 2) / tan(fov / 2)
  uniform float uSizeMul;     // splat overlap, so grazing surfaces stay opaque
  uniform float uMasked;      // 1 when depth 0 marks a pixel with no data
  uniform float uStride;      // grid decimation; splats scale with it

  attribute vec2 aPix;        // pixel coordinate inside the frame

  varying vec3 vColor;

  void main() {
    vec2 uv = (vec2(mod(uFrame, uGrid.x), floor(uFrame / uGrid.x))
               + (aPix + 0.5) / uSize) / uGrid;
    uv.y = 1.0 - uv.y;                 // atlas is top-down, WebGL samples bottom-up

    vec4 packed = texture2D(uDepth, uv);
    float q = packed.r * 255.0 * 256.0 + packed.g * 255.0;

    // Clouds that were filtered before export carry holes; those pixels are
    // stored as 0 and must be dropped rather than drawn at the near plane.
    if (uMasked > 0.5 && q < 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // outside the clip volume
      gl_PointSize = 0.0;
      vColor = vec3(1.0);
      return;
    }

    float d = uRange.x + (q / 65535.0) * (uRange.y - uRange.x);

    // back-project, then flip into three.js axes (y up, -z forward)
    vec3 p = vec3((aPix.x - uK.z) / uK.x * d, -(aPix.y - uK.w) / uK.y * d, -d);

    vColor = texture2D(uColor, uv).rgb;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // adjacent grid samples sit d / fx apart in world space; sizing the splat by
    // that keeps the surface watertight head-on and grows it correctly on zoom
    gl_PointSize = clamp(uSizeK * (d * uStride / uK.x) * uSizeMul / max(-mv.z, 0.0001), 1.0, 8.0);
  }
`;

const FRAG = /* glsl */`
  varying vec3 vColor;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;     // round splats break up the grid pattern
    gl_FragColor = vec4(vColor, 1.0);
  }
`;

export async function createPointCloudViewer(root, options = {}) {
  // `let`, not `const`: `stride` is also a runtime switch below, and assigning to
  // a destructured const throws.
  let {
    basePath,
    assetVersion = null,   // keep metadata and both atlases on one published revision
    background = 0xffffff,
    resumeDelayMs = 2600,
    rotateSpeed = 1.0,      // 1:1 with the pointer; lower feels like pushing through mud
    dampingFactor = 0.2,    // how fast the camera catches up; higher = snappier
    sizeMultiplier = 2.4,
    framePadding = 1.02,
    maxPixelRatio = 2,
    stride = 1,        // render every Nth source pixel; 1 = every one
    onFps = null,      // optional live frame-rate readout
    loop = true,       // false lets the caller drive the restart
    manual = false,    // true hands the camera entirely to the caller
    onView = null,     // fired while the viewer drags, for linking panels together
  } = options;

  const assetUrl = (name) => `${basePath}/${name}${assetVersion ? '?v=' + encodeURIComponent(assetVersion) : ''}`;
  const meta = await fetch(assetUrl('meta.json')).then((response) => {
    if (!response.ok) throw new Error(`meta.json: ${response.status}`);
    return response.json();
  });

  /* ── renderer ─────────────────────────────────────────────────────────── */

  const canvas = document.createElement('canvas');
  canvas.className = 'pcv-canvas';
  root.append(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(background, 1);
  // The colour atlas already holds display-ready sRGB bytes and nothing is lit,
  // so pass them through: a decode/encode pair would only shift the colours.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  const vfov = 2 * Math.atan(meta.height / (2 * meta.fy)) * (180 / Math.PI);
  const camera = new THREE.PerspectiveCamera(vfov, 1, 0.01, 100);
  camera.position.set(0, 0, 0);

  // the capture camera sat at the origin looking down -z in three.js axes
  const target = new THREE.Vector3(meta.centre[0], -meta.centre[1], -meta.centre[2]);

  /* ── textures ─────────────────────────────────────────────────────────── */

  const loader = new THREE.TextureLoader();
  const loadTexture = (url) => new Promise((resolve, reject) => {
    loader.load(url, (texture) => {
      texture.magFilter = THREE.NearestFilter;   // never interpolate packed bytes
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.colorSpace = THREE.NoColorSpace;
      resolve(texture);
    }, undefined, () => reject(new Error(`texture: ${url}`)));
  });

  const [depthTex, colorTex] = await Promise.all([
    loadTexture(assetUrl('depth_atlas.png')),
    loadTexture(assetUrl('rgb_atlas.jpg')),
  ]);

  /* ── geometry: one vertex per source pixel ────────────────────────────── */

  const geometry = new THREE.BufferGeometry();
  let pointCount = 0;

  /* One vertex per sampled source pixel. Decimating trades detail for frame rate
     on weaker machines; the splat grows with the stride so the surface stays
     watertight rather than turning into a sieve. */
  function buildGrid(step) {
    const gridW = Math.ceil(meta.width / step);
    const gridH = Math.ceil(meta.height / step);
    pointCount = gridW * gridH;
    const pix = new Float32Array(pointCount * 2);
    for (let y = 0, i = 0; y < meta.height; y += step) {
      for (let x = 0; x < meta.width; x += step, i++) {
        pix[i * 2] = x;
        pix[i * 2 + 1] = y;
      }
    }
    geometry.deleteAttribute('aPix');
    geometry.deleteAttribute('position');
    geometry.setAttribute('aPix', new THREE.BufferAttribute(pix, 2));
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pointCount * 3), 3));
    geometry.boundingSphere = new THREE.Sphere(target.clone(), 4);
    stride = step;
    if (uniforms) uniforms.uStride.value = step;
  }

  let uniforms = null;
  buildGrid(stride);

  uniforms = {
    uDepth: { value: depthTex },
    uColor: { value: colorTex },
    uGrid: { value: new THREE.Vector2(meta.cols, meta.rows) },
    uSize: { value: new THREE.Vector2(meta.width, meta.height) },
    uK: { value: new THREE.Vector4(meta.fx, meta.fy, meta.cx, meta.cy) },
    uRange: { value: new THREE.Vector2(meta.depthMin, meta.depthMax) },
    uFrame: { value: 0 },
    uSizeK: { value: 400 },
    uSizeMul: { value: sizeMultiplier },
    uMasked: { value: meta.masked ? 1 : 0 },
    uStride: { value: stride },
  };

  const points = new THREE.Points(geometry, new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
  }));
  points.frustumCulled = false;

  const scene = new THREE.Scene();
  scene.add(points);

  /* ── controls ─────────────────────────────────────────────────────────── */

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = dampingFactor;
  controls.rotateSpeed = rotateSpeed;
  controls.zoomSpeed = 1.0;
  /* Wheel zooms whenever the pointer is inside the viewer. The one guard: while
     the page is actively being scrolled, a wheel that happens to pass over the
     viewer keeps scrolling the page instead of trapping it. */
  controls.enableZoom = false;
  let pointerInside = false;
  let lastPageScroll = 0;

  canvas.addEventListener('pointerenter', () => { pointerInside = true; });
  canvas.addEventListener('pointerleave', () => { pointerInside = false; controls.enableZoom = false; });
  window.addEventListener('scroll', () => { lastPageScroll = performance.now(); }, { passive: true });

  canvas.addEventListener('wheel', (event) => {
    const pageIsScrolling = performance.now() - lastPageScroll < 250;
    controls.enableZoom = event.ctrlKey || event.metaKey
      || (pointerInside && !pageIsScrolling);
  }, { passive: true, capture: true });

  controls.update();

  const homeDir = camera.position.clone().sub(controls.target).normalize();
  const home = { target: controls.target.clone(), position: camera.position.clone() };

  const spherical = new THREE.Spherical();
  const offset = new THREE.Vector3();
  spherical.setFromVector3(offset.copy(camera.position).sub(controls.target));
  const baseTheta = spherical.theta;
  const basePhi = spherical.phi;

  /* Distance at which nothing leaves the frame anywhere in the sweep, for the
     current aspect ratio. Precomputed offline; the capture distance alone crops
     badly once the camera swings off axis. */
  function fitDistance(aspect) {
    const xs = meta.fitAspects;
    const ys = meta.fitDistances;
    if (!xs || !ys) return Math.hypot(...meta.centre);
    if (aspect <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) {
      if (aspect <= xs[i]) {
        const t = (aspect - xs[i - 1]) / (xs[i] - xs[i - 1]);
        return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
      }
    }
    return ys[ys.length - 1];
  }

  /* Centred puts the camera exactly where the capture camera stood -- not a
     millimetre further back. A single-view point cloud is hole-free from that one
     position only: any dolly along the axis is a change of viewpoint, and the
     parallax immediately opens up the occluded regions (the speckled fringe down
     the side of the bin). Exactness beats a safety margin here; a narrow box may
     crop the sides, which is more honest than manufactured holes. */
  function centredDistance() {
    return Math.hypot(...meta.centre);
  }

  function sweepDistance() {
    return fitDistance(camera.aspect) * framePadding;
  }

  function referenceDistance() {
    return state.sweeping ? sweepDistance() : centredDistance();
  }

  let applyingView = false;

  function getView() {
    spherical.setFromVector3(offset.copy(camera.position).sub(controls.target));
    return {
      theta: spherical.theta,
      phi: spherical.phi,
      ratio: spherical.radius / referenceDistance(),
    };
  }

  function setView(view) {
    applyingView = true;
    spherical.set(Math.max(1e-4, view.ratio * referenceDistance()), view.phi, view.theta);
    camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
    controls.update();
    applyingView = false;
  }

  function frameScene() {
    const distance = state.sweeping ? sweepDistance() : centredDistance();
    camera.position.copy(controls.target).addScaledVector(homeDir, distance);
    controls.update();
    home.position.copy(camera.position);
    controls.minDistance = distance * 0.45;
    controls.maxDistance = distance * 3;
  }

  /* ── playback state ───────────────────────────────────────────────────── */

  const passDuration = meta.frames / meta.fps;   // one pass = one task execution
  // How many task executions one -45 -> +45 traverse spans. At 1 the camera and
  // the clip share a clock; larger values let the task repeat while the camera
  // drifts slowly across, which reads calmer.
  const sweepPasses = Math.max(1, options.sweepPasses || meta.sweepPasses || 1);
  const sweepDuration = passDuration * sweepPasses;

  const state = {
    playing: true,
    time: 0,          // seconds into the current pass; drives the clip frame
    sweepTime: 0,     // seconds into the current traverse; drives the camera
    frame: -1,
    forward: true,    // sweep direction of the current pass
    sweeping: true,   // false = hold the head-on view instead of orbiting
    userControlled: false,
    resumeTimer: null,
    disposed: false,
  };

  /* Timed glide between camera states. An exponential decay was used here first
     and it crawls: the last few degrees take as long as the first forty. */
  const glide = { t: 1, duration: 0.45, theta: 0, phi: 0, radius: 0 };

  function beginGlide(duration) {
    spherical.setFromVector3(offset.copy(camera.position).sub(controls.target));
    glide.theta = spherical.theta;
    glide.phi = spherical.phi;
    glide.radius = spherical.radius;
    glide.t = 0;
    glide.duration = duration;
  }

  const easeInOut = (t) => t * t * (3 - 2 * t);
  const shortestAngle = (from, to) => from + Math.atan2(Math.sin(to - from), Math.cos(to - from));

  const setUserControlled = (on) => {
    state.userControlled = on;
    root.classList.toggle('is-user-controlled', on);
  };

  function scriptedTheta() {
    if (!state.sweeping) return baseTheta;       // centred: hold the head-on view
    // continuous in time, not in frame index: deriving this from the integer
    // frame would step the camera at the clip rate, which reads as judder
    const p = THREE.MathUtils.clamp(state.sweepTime / sweepDuration, 0, 1);
    const sweep = THREE.MathUtils.degToRad(meta.sweepDeg);
    const from = state.forward ? -sweep : sweep;
    return baseTheta + from + (-2 * from) * p;
  }

  function applyScriptedCamera(dt) {
    spherical.setFromVector3(offset.copy(camera.position).sub(controls.target));

    if (glide.t < 1) {
      glide.t = Math.min(1, glide.t + dt / glide.duration);
      const k = easeInOut(glide.t);
      // during a glide the elevation and the distance come home as well, which is
      // what makes "centre" actually match the captured framing
      spherical.theta = glide.theta + (shortestAngle(glide.theta, scriptedTheta()) - glide.theta) * k;
      spherical.phi = glide.phi + (basePhi - glide.phi) * k;
      const targetRadius = state.sweeping ? sweepDistance() : centredDistance();
      spherical.radius = glide.radius + (targetRadius - glide.radius) * k;
    } else {
      spherical.theta = scriptedTheta();         // afterwards leave zoom and tilt alone
    }

    camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
  }

  controls.addEventListener('change', () => {
    if (onView && !applyingView && (manual || state.userControlled)) onView(getView());
  });

  controls.addEventListener('start', () => {
    if (state.resumeTimer) { clearTimeout(state.resumeTimer); state.resumeTimer = null; }
    setUserControlled(true);
  });

  controls.addEventListener('end', () => {
    if (manual) return;                          // the caller owns the camera
    if (state.resumeTimer) clearTimeout(state.resumeTimer);
    state.resumeTimer = setTimeout(() => {
      beginGlide(0.8);                           // a touch slower coming back from a drag
      setUserControlled(false);
      state.resumeTimer = null;
    }, resumeDelayMs);
  });

  /* ── sizing ───────────────────────────────────────────────────────────── */

  function resize() {
    const width = root.clientWidth || 1;
    const height = root.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    uniforms.uSizeK.value = (height * dpr / 2) / Math.tan(THREE.MathUtils.degToRad(vfov) / 2);
    if (!state.userControlled) frameScene();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(root);
  resize();

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    state.disposed = true;
    root.classList.add('has-context-loss');
  });

  /* ── loop ─────────────────────────────────────────────────────────────── */

  const fps = { frames: 0, window: 0 };
  let last = performance.now();
  function tick(now) {
    if (state.disposed) return;
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;

    if (state.playing) {
      state.time += dt;
      while (state.time >= passDuration) state.time -= passDuration;

      state.sweepTime += dt;
      while (state.sweepTime >= sweepDuration) { // traverse done: swing back
        state.sweepTime -= sweepDuration;
        state.forward = !state.forward;
      }

      const frame = Math.min(Math.floor(state.time * meta.fps), meta.frames - 1);
      if (frame !== state.frame) {
        state.frame = frame;
        uniforms.uFrame.value = frame;
      }
    }

    if (!manual && !state.userControlled) applyScriptedCamera(dt);
    controls.update();
    renderer.render(scene, camera);

    if (onFps) {
      fps.frames += 1;
      fps.window += dt;
      if (fps.window >= 0.5) {
        onFps(Math.round(fps.frames / fps.window));
        fps.frames = 0;
        fps.window = 0;
      }
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  /* ── public surface ───────────────────────────────────────────────────── */

  return {
    meta,
    get pointCount() { return pointCount; },
    get playing() { return state.playing; },
    toggle() {
      state.playing = !state.playing;
      return state.playing;
    },
    get sweeping() { return state.sweeping; },
    setSweep(on) {
      if (state.sweeping === !!on) return state.sweeping;
      beginGlide(0.45);
      state.sweeping = !!on;
      if (state.resumeTimer) { clearTimeout(state.resumeTimer); state.resumeTimer = null; }
      setUserControlled(false);
      return state.sweeping;
    },
    getView,
    setView,
    setManual(on) {
      manual = !!on;
      if (manual) {
        if (state.resumeTimer) { clearTimeout(state.resumeTimer); state.resumeTimer = null; }
        setUserControlled(false);
      }
    },
    reframe() { frameScene(); },
    setFrame(i) {
      state.time = Math.max(0, Math.min(i, meta.frames - 1)) / meta.fps;
      state.frame = -1;                          // force the uniform to refresh
      state.sweepTime = 0;
    },
    get stride() { return stride; },
    setStride(step) {
      const n = Math.max(1, Math.round(step));
      if (n !== stride) buildGrid(n);
      return stride;
    },
    resetView() {
      if (state.resumeTimer) { clearTimeout(state.resumeTimer); state.resumeTimer = null; }
      controls.target.copy(home.target);
      beginGlide(0.45);
      setUserControlled(false);
    },
    dispose() {
      state.disposed = true;
      observer.disconnect();
      controls.dispose();
      geometry.dispose();
      depthTex.dispose();
      colorTex.dispose();
      renderer.dispose();
    },
  };
}
