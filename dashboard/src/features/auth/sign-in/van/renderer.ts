import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import modelUrl from '../assets/login-van.glb?url';
import { vanSettings as settings } from './settings.js';
import { fragmentShader, vertexShader } from './ordered-shader.js';

function disposeModel(model: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  for (const texture of textures) {
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap)
      texture.image.close();
    texture.dispose();
  }
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}

/** Owns all GPU resources and listeners. Never updates React on animation frames. */
export async function startVan(
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
  ready: (value: boolean) => void,
) {
  let renderer: THREE.WebGLRenderer | undefined;
  let model: THREE.Group | undefined;
  let target: THREE.WebGLRenderTarget | undefined;
  let material: THREE.ShaderMaterial | undefined;
  let geometry: THREE.PlaneGeometry | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let intersectionObserver: IntersectionObserver | undefined;
  let raf = 0,
    disposed = false,
    visible = true,
    elapsed = 0,
    last = 0,
    presented = 0;
  let width = 0,
    height = 0,
    shaderFailed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    document.removeEventListener('visibilitychange', visibilityChanged);
    canvas.removeEventListener('webglcontextlost', contextLost);
    signal.removeEventListener('abort', dispose);
    if (model) disposeModel(model);
    target?.dispose();
    material?.dispose();
    geometry?.dispose();
    renderer?.dispose();
    renderer?.forceContextLoss();
  };
  const contextLost = (event: Event) => {
    event.preventDefault();
    ready(false);
    dispose();
  };
  let schedule = () => {};
  const visibilityChanged = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    schedule();
  };
  signal.addEventListener('abort', dispose, { once: true });
  try {
    signal.throwIfAborted();
    // Create a context before fetching the model; unsupported browsers keep the poster.
    const webgl = (renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: 'low-power',
    }));
    webgl.outputColorSpace = THREE.LinearSRGBColorSpace;
    webgl.toneMapping = THREE.NoToneMapping;
    webgl.setClearColor(0x000000, 0);
    webgl.debug.onShaderError = () => {
      shaderFailed = true;
    };
    const response = await fetch(modelUrl, { signal });
    if (!response.ok) throw new Error('Van asset unavailable');
    const data = await response.arrayBuffer();
    signal.throwIfAborted();
    const gltf = await new GLTFLoader().parseAsync(data, '');
    if (disposed) {
      disposeModel(gltf.scene);
      return dispose;
    }
    const van = (model = gltf.scene);
    const scene = new THREE.Scene();
    scene.add(van);
    scene.add(new THREE.HemisphereLight('#eaf3ff', '#263040', 2.3));
    for (const [color, intensity, position] of [
      ['#ffffff', 3.4, [-5, 10, 7]],
      ['#dbeaff', 1.5, [4, 4, -7]],
      ['#ffffff', 0.75, [-8, 3, -2]],
    ] as const) {
      const light = new THREE.DirectionalLight(color, intensity);
      light.position.set(position[0], position[1], position[2]);
      scene.add(light);
    }
    const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    camera.position.set(...settings.cameraPosition);
    camera.lookAt(...settings.cameraTarget);
    const renderTarget = (target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    }));
    const uniforms = {
      sceneTexture: { value: renderTarget.texture },
      time: { value: 0 },
      pixelSize: { value: 1 },
      resolution: { value: new THREE.Vector2() },
    };
    material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms,
    });
    geometry = new THREE.PlaneGeometry(2, 2);
    const post = new THREE.Scene();
    post.add(new THREE.Mesh(geometry, material));
    const postCamera = new THREE.Camera();
    const render = () => {
      van.rotation.y = (elapsed * Math.PI * 2) / settings.rotationSeconds;
      uniforms.time.value = elapsed;
      webgl.setRenderTarget(renderTarget);
      webgl.render(scene, camera);
      webgl.setRenderTarget(null);
      webgl.render(post, postCamera);
      if (shaderFailed) throw new Error('Van shader unavailable');
    };
    const animate = (now: number) => {
      raf = 0;
      if (disposed || document.hidden || !visible || !width || !height) return;
      elapsed += Math.min((now - last) / 1000, 0.1);
      last = now;
      const interval = 1000 / settings.framesPerSecond;
      if (now - presented >= interval) {
        presented = now - ((now - presented) % interval);
        try {
          render();
        } catch {
          ready(false);
          dispose();
          return;
        }
      }
      raf = requestAnimationFrame(animate);
    };
    schedule = () => {
      if (disposed || raf || document.hidden || !visible || !width || !height) return;
      last = performance.now();
      raf = requestAnimationFrame(animate);
    };
    const resize = () => {
      if (disposed) return;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      if (!width || !height) {
        cancelAnimationFrame(raf);
        raf = 0;
        return;
      }
      const ratio = Math.min(
        devicePixelRatio,
        settings.maxPixelRatio,
        Math.sqrt(settings.maxPixels / (width * height)),
      );
      webgl.setPixelRatio(ratio);
      webgl.setSize(width, height, false);
      const aspect = width / height;
      const vertical = Math.max(
        settings.minimumVerticalFraming,
        settings.horizontalFraming / aspect,
      );
      camera.left = -vertical * aspect;
      camera.right = vertical * aspect;
      camera.top = vertical;
      camera.bottom = -vertical;
      camera.updateProjectionMatrix();
      const pixels = webgl.getDrawingBufferSize(new THREE.Vector2());
      renderTarget.setSize(pixels.x, pixels.y);
      uniforms.resolution.value.copy(pixels);
      uniforms.pixelSize.value =
        settings.orderedPixelSize * settings.textureScale * (width < 450 ? 0.82 : 1) * ratio;
      render();
      schedule();
    };
    resize();
    ready(true);
    resizeObserver = new ResizeObserver(() => {
      try {
        resize();
      } catch {
        ready(false);
        dispose();
      }
    });
    resizeObserver.observe(canvas);
    intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      visibilityChanged();
    });
    intersectionObserver.observe(canvas);
    document.addEventListener('visibilitychange', visibilityChanged);
    canvas.addEventListener('webglcontextlost', contextLost);
    return dispose;
  } catch {
    dispose();
    if (!signal.aborted) ready(false);
    return dispose;
  }
}
