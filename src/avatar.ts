import {
  ACESFilmicToneMapping, Box3, DirectionalLight, Euler, HemisphereLight, LoadingManager, Material,
  Object3D, OrthographicCamera, Quaternion, Scene, SRGBColorSpace, Texture,
  Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader, type GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { VRMHumanBoneName, VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { rgbaToShape } from './move-policy.mjs';

export interface AvatarDiagnostics {
  loaded: boolean;
  visible: boolean;
  animating: boolean;
  reducedMotion: boolean;
  moving: boolean;
  renderedFrames: number;
  fps: number;
  modelName: string | null;
  triangles: number;
  drawCalls: number;
  geometries: number;
  textures: number;
  loadTimeMs: number | null;
  pixelRatio: number;
  error: string | null;
}

type BoneBinding = { node: Object3D; rest: Quaternion };

/** A small, local-only VRM surface. Window/input management lives in the main process. */
export class Avatar {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  private readonly bones = new Map<string, BoneBinding>();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly rotation = new Quaternion();
  private readonly motion = matchMedia('(prefers-reduced-motion: reduce)');
  private vrm: VRM | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private visible = true;
  private moving = false;
  private disposed = false;
  private loadVersion = 0;
  private elapsed = 0;
  private lastFrame = 0;
  private sampleStart = 0;
  private sampleFrames = 0;
  private frameHeight = 2;
  private blinkNames: string[] = [];

  public readonly diagnostics: AvatarDiagnostics = {
    loaded: false, visible: true, animating: false, reducedMotion: false, moving: false,
    renderedFrames: 0, fps: 0, modelName: null, triangles: 0, drawCalls: 0,
    geometries: 0, textures: 0, loadTimeMs: null, pixelRatio: 1, error: null,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas, alpha: true, antialias: true, powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Compress bright skin/clothing highlights before display rather than clipping
    // them to white; keep exposure neutral for the first native visual baseline.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = false;
    this.scene.add(new HemisphereLight(0xffffff, 0xc7d6ea, 1.6));
    const light = new DirectionalLight(0xfff8f0, 1.8);
    light.position.set(-1, 2, 3);
    this.scene.add(light);
    this.camera.position.set(0, 0, 6);
    this.diagnostics.reducedMotion = this.motion.matches;
    this.motion.addEventListener('change', this.onMotionChanged);
    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  public async load(buffer: ArrayBuffer): Promise<boolean> {
    this.clear();
    const version = this.loadVersion;
    const started = performance.now();
    const vrm = await parseModel(buffer);
    if (this.disposed || version !== this.loadVersion) {
      VRMUtils.deepDispose(vrm.scene);
      return false;
    }
    try {
      this.vrm = vrm;
      this.scene.add(vrm.scene);
      for (const name of [VRMHumanBoneName.Head, VRMHumanBoneName.Chest,
        VRMHumanBoneName.LeftUpperArm, VRMHumanBoneName.RightUpperArm]) {
        const node = vrm.humanoid.getNormalizedBoneNode(name);
        if (node) this.bones.set(name, { node, rest: node.quaternion.clone() });
      }
      this.pose(VRMHumanBoneName.LeftUpperArm, 0, 0, -Math.PI * 0.4);
      this.pose(VRMHumanBoneName.RightUpperArm, 0, 0, Math.PI * 0.4);
      const expressions = Object.keys(vrm.expressionManager?.expressionMap ?? {});
      this.blinkNames = expressions.includes('blink') ? ['blink']
        : expressions.filter(name => name === 'blinkLeft' || name === 'blinkRight');
      vrm.update(0);
      vrm.scene.updateMatrixWorld(true);
      // Precise bounds include the skinned rest pose after lowering the arms.
      const bounds = new Box3().setFromObject(vrm.scene, true);
      const size = bounds.getSize(new Vector3());
      if (bounds.isEmpty() || !Number.isFinite(size.length()) || size.y <= 0) {
        throw new Error('モデルの大きさを確認できませんでした。');
      }
      const center = bounds.getCenter(new Vector3());
      vrm.scene.position.sub(center);
      const aspect = Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight);
      this.frameHeight = Math.max(size.y, size.x / aspect) * 1.12;
      this.camera.position.z = Math.max(6, size.z + size.y * 3);
      this.camera.far = this.camera.position.z + size.z + size.y * 3;
      const meta = vrm.meta as unknown as Record<string, unknown>;
      const name = meta.name ?? meta.title;
      this.diagnostics.modelName = typeof name === 'string' ? name : 'VRM';
      this.diagnostics.loaded = true;
      this.diagnostics.loadTimeMs = Math.round(performance.now() - started);
      this.resize();
      this.resume();
      return true;
    } catch (error) {
      this.clear();
      throw error;
    }
  }

  public clear(): void {
    this.loadVersion += 1;
    this.pause();
    this.moving = false;
    this.diagnostics.moving = false;
    if (this.vrm) {
      this.vrm.scene.removeFromParent();
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.bones.clear();
    this.blinkNames = [];
    this.elapsed = 0;
    this.diagnostics.loaded = false;
    this.diagnostics.modelName = null;
    this.diagnostics.error = null;
    this.diagnostics.loadTimeMs = null;
    this.diagnostics.triangles = 0;
    this.diagnostics.drawCalls = 0;
    this.diagnostics.geometries = 0;
    this.diagnostics.textures = 0;
    this.renderer.renderLists.dispose();
    if (!this.disposed && this.visible) this.renderer.clear();
  }

  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.diagnostics.visible = visible;
    if (visible) {
      if (!this.vrm && !this.disposed) this.renderer.clear();
      this.resume();
    }
    else this.pause();
  }

  /** Snapshot only our canvas, once, while its displayed pose stays frozen. */
  public enterMoveMode(): Array<{ x: number; y: number; width: number; height: number }> {
    if (this.disposed || !this.visible || !this.vrm) {
      throw new Error('しずくが表示されてから、もう一度試してください。');
    }
    this.pause();
    this.moving = true;
    this.diagnostics.moving = true;
    // Do not call draw(0): even a zero delta would update bones, expressions and
    // spring bones. The shaped window must match exactly this frozen frame.
    this.renderCurrentFrame();
    const gl = this.renderer.getContext();
    if (gl.isContextLost()) throw new Error('描画を確認できませんでした。');
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (width !== window.innerWidth || height !== window.innerHeight) {
      throw new Error('表示倍率の変更が終わってから、もう一度試してください。');
    }
    const pixels = new Uint8Array(width * height * 4);
    // Immediate readback is intentional: preserveDrawingBuffer remains disabled.
    // This is our WebGL drawing buffer, never a desktop/screen capture.
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const shape = rgbaToShape(pixels, width, height);
    if (shape.length === 0) throw new Error('しずくの輪郭を確認できませんでした。');
    return shape;
  }

  public exitMoveMode(): void {
    if (!this.moving) return;
    this.moving = false;
    this.diagnostics.moving = false;
    this.resume();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.motion.removeEventListener('change', this.onMotionChanged);
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private readonly onResize = (): void => this.resize();
  private readonly onMotionChanged = (): void => {
    this.diagnostics.reducedMotion = this.motion.matches;
    this.pause();
    this.resume();
  };

  private resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    this.renderer.setSize(width, height, false);
    this.camera.top = this.frameHeight / 2;
    this.camera.bottom = -this.camera.top;
    this.camera.right = this.camera.top * width / height;
    this.camera.left = -this.camera.right;
    this.camera.updateProjectionMatrix();
    if (this.visible && this.vrm) {
      if (this.moving) this.renderCurrentFrame();
      else this.draw(0);
    }
  }

  private resume(): void {
    if (this.disposed || !this.visible || this.moving || !this.vrm || this.timer !== null) return;
    this.lastFrame = performance.now();
    this.sampleStart = this.lastFrame;
    this.sampleFrames = 0;
    this.draw(0);
    // Reduced-motion mode is a still pose and consumes no repeating render timer.
    if (this.motion.matches) return;
    this.diagnostics.animating = true;
    this.timer = setTimeout(this.tick, Math.ceil(1000 / 30));
  }

  private pause(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.diagnostics.animating = false;
    this.diagnostics.fps = 0;
  }

  private readonly tick = (): void => {
    this.timer = null;
    if (this.disposed || !this.visible || this.moving || !this.vrm || this.motion.matches) return;
    const started = performance.now();
    const delta = Math.min((started - this.lastFrame) / 1000, 0.1);
    this.lastFrame = started;
    this.elapsed += delta;
    this.draw(delta);
    this.sampleFrames += 1;
    if (started - this.sampleStart >= 1000) {
      this.diagnostics.fps = Math.round(this.sampleFrames * 10000 / (started - this.sampleStart)) / 10;
      this.sampleStart = started;
      this.sampleFrames = 0;
    }
    // Schedule after work; never busy-loop or ask for the display's full refresh rate.
    this.timer = setTimeout(this.tick, Math.max(1, Math.ceil(1000 / 30 - (performance.now() - started))));
  };

  private draw(delta: number): void {
    const vrm = this.vrm;
    if (!vrm) return;
    const time = this.motion.matches ? 0 : this.elapsed;
    this.pose(VRMHumanBoneName.Head, Math.sin(time * 0.53) * 0.008,
      Math.sin(time * 0.23) * 0.025, Math.sin(time * 0.31) * 0.012);
    this.pose(VRMHumanBoneName.Chest, Math.sin(time * 1.35) * 0.004, 0, 0);
    const blinkPhase = (time + 1.8) % 5.6;
    const blink = !this.motion.matches && blinkPhase < 0.18
      ? Math.sin(blinkPhase / 0.18 * Math.PI) : 0;
    for (const name of this.blinkNames) vrm.expressionManager?.setValue(name, blink);
    vrm.update(delta);
    this.renderCurrentFrame();
  }

  private renderCurrentFrame(): void {
    this.renderer.render(this.scene, this.camera);
    this.diagnostics.renderedFrames += 1;
    this.diagnostics.triangles = this.renderer.info.render.triangles;
    this.diagnostics.drawCalls = this.renderer.info.render.calls;
    this.diagnostics.geometries = this.renderer.info.memory.geometries;
    this.diagnostics.textures = this.renderer.info.memory.textures;
  }

  private pose(name: string, x: number, y: number, z: number): void {
    const binding = this.bones.get(name);
    if (!binding) return;
    this.euler.set(x, y, z, 'YXZ');
    this.rotation.setFromEuler(this.euler);
    binding.node.quaternion.copy(binding.rest).multiply(this.rotation);
  }
}

async function parseModel(buffer: ArrayBuffer): Promise<VRM> {
  const manager = new LoadingManager();
  manager.setURLModifier(url => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    throw new Error('外部ファイルを参照するモデルは読み込めません。');
  });
  const loader = new GLTFLoader(manager);
  const parsers: GLTFParser[] = [];
  let parsedScene: Object3D | null = null;
  loader.register(parser => {
    parsers.push(parser);
    return {
      name: 'LocalEmbeddedResourcesOnly',
      beforeRoot: async () => {
        // A blob URL supplied by the input is also rejected. Only loader-created blobs
        // and embedded data can reach the LoadingManager above.
        for (const entry of [...(parser.json.buffers ?? []), ...(parser.json.images ?? [])]) {
          if (entry.uri !== undefined && (typeof entry.uri !== 'string' || !entry.uri.startsWith('data:'))) {
            throw new Error('画像やデータを内蔵したVRMを選んでください。');
          }
        }
      },
      afterRoot: async result => { parsedScene = result.scene; },
    };
  });
  loader.register(parser => new VRMLoaderPlugin(parser));
  try {
    const gltf = await loader.parseAsync(buffer, '');
    parsedScene = gltf.scene;
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm?.humanoid || typeof vrm.update !== 'function') {
      throw new Error('選択したファイルは対応するVRMモデルではありません。');
    }
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.rotateVRM0(vrm);
    return vrm;
  } catch (error) {
    if (parsedScene) VRMUtils.deepDispose(parsedScene);
    else {
      // Parsing can fail before a root scene is produced; release available partial
      // resources too, instead of leaving successfully decoded textures behind.
      for (const parser of parsers) {
        for (const resource of parser.associations.keys()) {
          if (resource instanceof Object3D) VRMUtils.deepDispose(resource);
          else if (resource instanceof Material || resource instanceof Texture) resource.dispose();
        }
      }
    }
    throw error;
  }
}
