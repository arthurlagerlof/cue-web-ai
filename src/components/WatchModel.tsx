import { useEffect, useRef, useState } from 'react';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Box3,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  Material,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

type WatchModelProps = {
  mode: 'hero' | 'demo';
  title: string;
  message: string;
  action?: string;
  onScreenAction: () => void;
  screenActionDisabled?: boolean;
  scrollProgressRef?: { current: number };
};

type DisplayText = Pick<WatchModelProps, 'title' | 'message' | 'action'>;

let modelAsset: Promise<Group> | undefined;

function loadModel() {
  if (!modelAsset) {
    modelAsset = new GLTFLoader().loadAsync('/assets/bangle.glb')
      .then(gltf => gltf.scene)
      .catch(error => {
        modelAsset = undefined;
        throw error;
      });
  }
  return modelAsset;
}

function drawDisplay(context: CanvasRenderingContext2D, display: DisplayText) {
  const { width, height } = context.canvas;
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#000000';
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  const title = display.title.length > 18 ? `${display.title.slice(0, 17)}…` : display.title;
  context.font = 'bold 92px "Century Gothic", "Avenir Next", sans-serif';
  context.fillText(title, width / 2, height * 0.34, width * 0.82);

  context.font = '48px "Century Gothic", "Avenir Next", sans-serif';
  const words = display.message.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width > width * 0.78 && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  const visibleLines = lines.slice(0, 3);
  visibleLines.forEach((value, index) => context.fillText(value, width / 2, height * 0.49 + index * 58, width * 0.82));

  if (display.action) {
    context.font = 'bold 38px "Century Gothic", "Avenir Next", sans-serif';
    context.fillText(display.action, width / 2, height * 0.77, width * 0.82);
  }
}

export default function WatchModel({ mode, title, message, action, onScreenAction, screenActionDisabled = false, scrollProgressRef }: WatchModelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<DisplayText>({ title, message, action });
  const displayCanvasRef = useRef<HTMLCanvasElement>();
  const displayTextureRef = useRef<CanvasTexture>();
  const actionRef = useRef(onScreenAction);
  const [modelError, setModelError] = useState('');
  displayRef.current = { title, message, action };
  actionRef.current = onScreenAction;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let frame = 0;
    let screenTexture: CanvasTexture | undefined;
    let clonedScreenMaterials: Material[] = [];
    let model: Group | undefined;
    let fitSize: Vector3 | undefined;
    let introStart: number | undefined;
    let previousFrame: number | undefined;
    let hoverBlend = 0;
    let demoExit = 1;
    let demoExitFrom = 1;
    let demoExitTarget = 1;
    let demoAnimationStart = 0;
    let pointer: Vector2 | undefined;
    const hero = mode === 'hero' ? host.closest<HTMLElement>('.landing-hero') : null;
    const demo = mode === 'demo' ? host.closest<HTMLElement>('.landing-demo') : null;
    const demoWatch = mode === 'demo' ? host.closest<HTMLElement>('.demo-watch') : null;
    const finishIntro = () => {
      hero?.style.setProperty('--intro-daylight', '1');
      hero?.style.setProperty('--intro-sunrise', '0');
    };
    const screenMeshes: Mesh[] = [];
    const watchMeshes: Mesh[] = [];
    const raycaster = new Raycaster();
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    } catch (error) {
      finishIntro();
      setModelError(`WebGL is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    host.appendChild(renderer.domElement);

    const scene = new Scene();
    const modelGroup = new Group();
    scene.add(modelGroup);
    const camera = new PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 0, 5.4);
    camera.lookAt(0, 0, 0);
    const ambientLight = new AmbientLight(0xffffff, 1.7);
    scene.add(ambientLight);
    const keyLight = new DirectionalLight(0xffffff, 2.4);
    keyLight.position.set(-3, 5, 6);
    scene.add(keyLight);
    const fillLight = new DirectionalLight(0xc8e7ff, 1.0);
    fillLight.position.set(4, -2, 1);
    scene.add(fillLight);
    const sunriseLight = new DirectionalLight(0xff793e, 0);
    sunriseLight.position.set(-1, 2, 4);
    scene.add(sunriseLight);

    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (fitSize) {
        const halfFovTangent = Math.tan((camera.fov * Math.PI) / 360);
        const narrowHero = mode === 'hero' && window.matchMedia('(max-width: 700px)').matches;
        const distanceForHeight = fitSize.y / (2 * halfFovTangent * (mode === 'hero' ? (narrowHero ? 0.6 : 0.76) : 1));
        const distanceForWidth = fitSize.x / (2 * halfFovTangent * camera.aspect * (mode === 'hero' ? (narrowHero ? 0.8 : 0.5) : 1));
        camera.position.z = Math.max(distanceForHeight, distanceForWidth) * 1.12 + fitSize.z / 2;
        camera.lookAt(0, 0, 0);
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const onCanvasClick = (event: MouseEvent) => {
      if (!screenMeshes.length) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      const pointer = new Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.intersectObjects(screenMeshes, true).length) actionRef.current();
    };
    const onPointerMove = (event: PointerEvent) => {
      pointer = new Vector2(event.clientX, event.clientY);
    };
    const onPointerLeave = () => { pointer = undefined; };
    renderer.domElement.addEventListener('click', onCanvasClick);
    if (mode === 'demo') {
      renderer.domElement.addEventListener('pointermove', onPointerMove);
      renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    }

    const renderFrame = (time: number) => {
      frame = window.requestAnimationFrame(renderFrame);
      if (model) {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const delta = previousFrame === undefined ? 0 : Math.min((time - previousFrame) / 1000, 0.1);
        previousFrame = time;
        if (mode === 'hero') {
          if (introStart === undefined) introStart = time;
          const intro = reduceMotion ? 1 : Math.min((time - introStart) / 5500, 1);
          const ease = intro * intro * (3 - 2 * intro);
          const daylight = Math.max(0, Math.min((intro - 0.48) / 0.52, 1));
          const sunrise = Math.sin(Math.PI * intro);
          hero?.style.setProperty('--intro-daylight', String(daylight));
          hero?.style.setProperty('--intro-sunrise', String(sunrise));
          const progress = reduceMotion ? 0 : scrollProgressRef?.current ?? 0;
          const narrow = window.matchMedia('(max-width: 700px)').matches;
          const viewHeight = 2 * Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
          const viewWidth = viewHeight * camera.aspect;
          modelGroup.position.x = -viewWidth * ((narrow ? 0 : 0.25) + 0.9 * progress) * ease;
          modelGroup.position.y = narrow ? -viewHeight * 0.17 * ease : 0;
          modelGroup.position.z = (camera.position.z - (fitSize?.z ?? 0) / 2) * 0.75 * (1 - ease);
          modelGroup.rotation.x = -1.05 * (1 - ease);
          modelGroup.rotation.z = -70 * Math.PI / 180 * progress;
          ambientLight.intensity = 0.35 + 1.35 * ease;
          keyLight.intensity = 0.35 + 2.05 * ease;
          fillLight.intensity = 0.2 + 0.8 * ease;
          sunriseLight.intensity = 3 * sunrise;
          model.rotation.y = -0.55 + (reduceMotion ? 0 : Math.sin(time / 1800) * 0.018);
        } else {
          const narrow = window.matchMedia('(max-width: 700px)').matches;
          let hovering = false;
          if (!narrow && !reduceMotion && pointer && window.matchMedia('(hover: hover)').matches) {
            const bounds = renderer.domElement.getBoundingClientRect();
            const normalizedPointer = new Vector2(
              ((pointer.x - bounds.left) / bounds.width) * 2 - 1,
              -((pointer.y - bounds.top) / bounds.height) * 2 + 1,
            );
            raycaster.setFromCamera(normalizedPointer, camera);
            hovering = raycaster.intersectObjects(watchMeshes, false).length > 0;
          }
          hoverBlend += ((hovering ? 1 : 0) - hoverBlend) * (1 - Math.exp(-7 * delta));

          const bounds = demo?.getBoundingClientRect();
          const target = reduceMotion || !bounds || (bounds.top < window.innerHeight && bounds.bottom > 0) ? 0 : 1;
          if (target !== demoExitTarget) {
            demoExitFrom = demoExit;
            demoExitTarget = target;
            demoAnimationStart = time;
          }
          const progress = reduceMotion ? 1 : Math.min((time - demoAnimationStart) / 700, 1);
          const ease = progress * progress * (3 - 2 * progress);
          demoExit = demoExitFrom + (demoExitTarget - demoExitFrom) * ease;
          const exit = demoExit;
          demoWatch?.style.setProperty('--demo-exit', String(exit));

          const idle = narrow || reduceMotion ? 0 : 1 - hoverBlend;
          modelGroup.rotation.x = -1.05 * (0.5 + 0.5 * Math.cos(time / 2200)) * idle;
          modelGroup.rotation.y = Math.sin(time / 2600) * 0.16 * idle;
          modelGroup.rotation.z = Math.sin(time / 3100) * 0.12 * idle + exit * Math.PI / 2;
          model.rotation.y = -0.55 * idle;
        }
        renderer.render(scene, camera);
      }
    };
    frame = window.requestAnimationFrame(renderFrame);

    void loadModel()
      .then(gltfScene => {
        if (disposed) return;
        model = gltfScene.clone(true);
        const shortBand = model.getObjectByName('BandShort');
        const longBand = model.getObjectByName('BandLong');
        const screen = model.getObjectByName('WatchScreen');
        if (!shortBand || !longBand || !screen) {
          throw new Error('The Bangle.js 2 GLB is missing BandShort, BandLong, or WatchScreen.');
        }
        shortBand.visible = mode !== 'demo';
        longBand.visible = mode !== 'demo';
        const screenCanvas = document.createElement('canvas');
        screenCanvas.width = 512;
        screenCanvas.height = 512;
        const context = screenCanvas.getContext('2d');
        if (!context) throw new Error('Could not create the watch display canvas.');
        drawDisplay(context, displayRef.current);
        const displayTexture = new CanvasTexture(screenCanvas);
        screenTexture = displayTexture;
        displayTexture.colorSpace = SRGBColorSpace;
        displayTexture.flipY = false;
        displayCanvasRef.current = screenCanvas;
        displayTextureRef.current = displayTexture;
        screen.traverse(object => {
          if (!(object instanceof Mesh)) return;
          screenMeshes.push(object);
          const originalMaterials = Array.isArray(object.material) ? object.material : [object.material];
          const materials = originalMaterials.map(material => {
            const cloned = material.clone();
            if (cloned instanceof MeshStandardMaterial) {
              cloned.map = displayTexture;
              cloned.emissive = new Color(0xffffff);
              cloned.emissiveMap = displayTexture;
              cloned.emissiveIntensity = 0.12;
              cloned.needsUpdate = true;
            }
            clonedScreenMaterials.push(cloned);
            return cloned;
          });
          object.material = Array.isArray(object.material) ? materials : materials[0];
        });
        model.rotation.set(Math.PI / 2, -0.55, 0);
        const bounds = new Box3();
        if (mode === 'demo') {
          const watchBody = model.getObjectByName('body');
          if (!watchBody) throw new Error('The Bangle.js 2 GLB is missing the body mesh.');
          bounds.expandByObject(watchBody);
          bounds.expandByObject(screen);
          watchBody.traverse(object => { if (object instanceof Mesh) watchMeshes.push(object); });
          watchMeshes.push(...screenMeshes);
        } else {
          bounds.setFromObject(model);
        }
        const center = bounds.getCenter(new Vector3());
        const size = bounds.getSize(new Vector3());
        const scale = 2.55 / Math.max(size.x, size.y, size.z);
        fitSize = size.clone().multiplyScalar(scale);
        model.scale.setScalar(scale);
        model.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
        modelGroup.add(model);
        resize();
      })
      .catch(error => {
        if (!disposed) {
          model = undefined;
          finishIntro();
          setModelError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('click', onCanvasClick);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      demoWatch?.style.removeProperty('--demo-exit');
      if (displayTextureRef.current === screenTexture) {
        displayTextureRef.current = undefined;
        displayCanvasRef.current = undefined;
      }
      screenTexture?.dispose();
      clonedScreenMaterials.forEach(material => material.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      finishIntro();
    };
  }, [mode, scrollProgressRef]);

  useEffect(() => {
    const canvas = displayCanvasRef.current;
    const texture = displayTextureRef.current;
    const context = canvas?.getContext('2d');
    if (!context) return;
    drawDisplay(context, { title, message, action });
    if (texture) texture.needsUpdate = true;
  }, [title, message, action]);

  return <div
    className={`watch-model watch-model-${mode}`}
    ref={hostRef}
    role={mode === 'demo' ? 'button' : 'img'}
    tabIndex={mode === 'demo' ? 0 : undefined}
    aria-disabled={mode === 'demo' ? screenActionDisabled : undefined}
    aria-label={`3D Bangle.js 2 watch. ${title}. ${message}${action ? `. ${action}.` : ''}`}
    onKeyDown={event => {
      if (mode === 'demo' && !screenActionDisabled && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        actionRef.current();
      }
    }}
  >
    {modelError && <p className="watch-model-error" role="status">3D watch unavailable: {modelError}</p>}
  </div>;
}
