import {
  ACESFilmicToneMapping, Box3, DirectionalLight, Euler, HemisphereLight, LoadingManager, Material,
  Object3D, OrthographicCamera, Quaternion, Scene, SkinnedMesh, SRGBColorSpace, Texture,
  Vector3, WebGLRenderer,
} from 'three';
import { GLTFLoader, type GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { VRMHumanBoneName, VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { rgbaToShape } from './move-policy.mjs';
import { CALL_RESPONSE_MS, callExpression, sampleCallResponse } from './call-response.mjs';
import { ModelImages, trackModelImages } from './model-images';
import { STANDING_POSE, SITTING_POSE, POSTURE_TRANSITION_MS, postureEase } from './posture.mjs';

export type Posture = 'standing' | 'sitting';

export interface AvatarDiagnostics {
  quiet: boolean;
  facing: 'left' | 'right';
  changingFacing: boolean;
  seatAnchor: { x: number; y: number } | null;
  loaded: boolean;
  visible: boolean;
  animating: boolean;
  contextLost: boolean;
  reducedMotion: boolean;
  moving: boolean;
  reacting: boolean;
  reactionProgress: number;
  posture: Posture;
  postureBlend: number;
  changingPosture: boolean;
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
  private modelImages: ModelImages | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reactionTimer: ReturnType<typeof setTimeout> | null = null;
  private reactionStarted: number | null = null;
  private reactionExpression: string | null = null;
  private reactionExpressionRest = 0;
  private visible = true;
  private moving = false;
  private contextLost = false;
  private disposed = false;
  private loadVersion = 0;
  private elapsed = 0;
  private lastFrame = 0;
  private sampleStart = 0;
  private sampleFrames = 0;
  private modelWidth = 0;
  private modelHeight = 0;
  private blinkNames: string[] = [];
  private posture: Posture = 'standing';
  private postureMix = 0;
  private postureFrom = 0;
  private postureElapsed = POSTURE_TRANSITION_MS;
  private needsFraming = false;
  private readonly modelOrigin = new Vector3();
  private modelYaw = 0;
  private standingWidth = 0;
  private standingHeight = 0;
  private quiet = false;
  private facing: 'left' | 'right' = 'right';
  private facingMix = 1;
  private facingFrom = 1;
  private facingElapsed = 450;

  public readonly diagnostics: AvatarDiagnostics = {
    quiet: false, facing: 'right', changingFacing: false, seatAnchor: null,
    loaded: false, visible: true, animating: false, contextLost: false, reducedMotion: false, moving: false,
    reacting: false, reactionProgress: 0,
    posture: 'standing', postureBlend: 0, changingPosture: false,
    renderedFrames: 0, fps: 0, modelName: null, triangles: 0, drawCalls: 0,
    geometries: 0, textures: 0, loadTimeMs: null, pixelRatio: 1, error: null,
  };

  constructor(
    canvas: HTMLCanvasElement,
    private readonly onContextAvailabilityChanged?: (available: boolean) => void,
    private readonly onFrame?: () => void,
  ) {
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
    // Register after Three's own listeners: its restored handler synchronously
    // rebuilds GPU state before we draw again. Retain model/ImageBitmap data so
    // Three can upload it into the restored context without reloading the file.
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
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
    const images = new ModelImages();
    this.modelImages = images;
    const started = performance.now();
    const vrm = await parseModel(buffer, images);
    if (this.disposed || version !== this.loadVersion) {
      VRMUtils.deepDispose(vrm.scene);
      images.dispose();
      return false;
    }
    try {
      this.vrm = vrm;
      // Three caches a skinned mesh's first bounding sphere. Bent legs can move
      // shoes out of that old sphere, incorrectly culling them after sitting.
      // This scene contains one fully framed avatar: keep its deformed parts
      // visible without recomputing every mesh sphere in the idle loop.
      vrm.scene.traverse(object => { if (object instanceof SkinnedMesh) object.frustumCulled = false; });
      this.scene.add(vrm.scene);
      for (const name of [VRMHumanBoneName.Head, VRMHumanBoneName.Chest, ...Object.keys(STANDING_POSE)]) {
        const node = vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
        if (node) this.bones.set(name, { node, rest: node.quaternion.clone() });
      }
      this.modelOrigin.copy(vrm.scene.position);
      this.modelYaw = vrm.scene.rotation.y;
      // Use the same apparent body scale when sitting. Measure the standing
      // reference once, including when the saved startup posture is sitting.
      const selectedMix = this.postureMix;
      this.postureMix = 0;
      this.applyPosture();
      if (this.hasContext()) vrm.update(0); else vrm.humanoid.update();
      vrm.scene.updateMatrixWorld(true);
      const standingSize = new Box3().setFromObject(vrm.scene, true).getSize(new Vector3());
      this.standingWidth = standingSize.x;
      this.standingHeight = standingSize.y;
      this.postureMix = selectedMix;
      this.applyPosture();
      const expressions = Object.keys(vrm.expressionManager?.expressionMap ?? {});
      this.reactionExpression = callExpression(expressions);
      this.blinkNames = expressions.includes('blink') ? ['blink']
        : expressions.filter(name => name === 'blinkLeft' || name === 'blinkRight');
      if (this.hasContext()) vrm.update(0);
      // Loading may finish during an outage. Apply only the rest pose needed for
      // bounds; animation, expressions and spring simulation wait for recovery.
      else vrm.humanoid.update();
      this.framePosture();
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
    this.cancelReaction();
    this.moving = false;
    this.diagnostics.moving = false;
    if (this.vrm) {
      this.vrm.scene.removeFromParent();
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.modelImages?.dispose();
    this.modelImages = null;
    this.bones.clear();
    this.blinkNames = [];
    this.reactionExpression = null;
    this.elapsed = 0;
    this.finishPosture();
    this.finishFacing();
    this.diagnostics.seatAnchor = null;
    this.modelWidth = 0;
    this.modelHeight = 0;
    this.standingHeight = 0;
    this.standingWidth = 0;
    this.diagnostics.loaded = false;
    this.diagnostics.modelName = null;
    this.diagnostics.error = null;
    this.diagnostics.loadTimeMs = null;
    this.diagnostics.triangles = 0;
    this.diagnostics.drawCalls = 0;
    this.diagnostics.geometries = 0;
    this.diagnostics.textures = 0;
    this.renderer.renderLists.dispose();
    if (this.visible && this.hasContext()) this.renderer.clear();
  }

  public setVisible(visible: boolean): void {
    // Main's ready handshake and document visibility can repeat the same state.
    // Lifecycle transitions (load, context restore, motion and move) resume their
    // own work; duplicate visibility notifications must not redraw a still pose.
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.diagnostics.visible = visible;
    if (visible) {
      if (!this.vrm && this.hasContext()) this.renderer.clear();
      this.resume();
    }
    else {
      this.pause();
      this.cancelReaction();
      this.finishPosture();
      this.finishFacing();
    }
  }

  public setPosture(posture: Posture): void {
    if (this.disposed || (posture !== 'standing' && posture !== 'sitting') || posture === this.posture) return;
    this.cancelReaction();
    this.posture = posture;
    this.diagnostics.posture = posture;
    this.postureFrom = this.postureMix;
    this.postureElapsed = 0;
    this.diagnostics.changingPosture = true;
    this.needsFraming = true;
    if (!this.visible || this.still() || !this.vrm) this.finishPosture();
    this.resume();
  }

  private still(): boolean { return this.motion.matches || this.quiet; }

  public setPresence(facing: 'left' | 'right', quiet: boolean): void {
    if (this.disposed || (facing === this.facing && quiet === this.quiet)) return;
    this.pause();
    this.cancelReaction();
    if (facing !== this.facing) {
      this.facing = facing;
      this.facingFrom = this.facingMix;
      this.facingElapsed = 0;
      this.diagnostics.changingFacing = true;
      this.needsFraming = true;
    }
    this.quiet = quiet;
    this.diagnostics.quiet = quiet;
    this.diagnostics.facing = facing;
    if (this.still() || !this.visible || !this.vrm) { this.finishPosture(); this.finishFacing(); }
    this.resume();
  }

  private finishFacing(): void {
    this.facingMix = this.facing === 'left' ? -1 : 1;
    this.facingFrom = this.facingMix;
    this.facingElapsed = 450;
    this.diagnostics.changingFacing = false;
    this.needsFraming = true;
  }

  private finishPosture(): void {
    this.postureMix = this.posture === 'sitting' ? 1 : 0;
    this.postureFrom = this.postureMix;
    this.postureElapsed = POSTURE_TRANSITION_MS;
    this.diagnostics.postureBlend = this.postureMix;
    this.diagnostics.changingPosture = false;
    this.needsFraming = true;
  }

  private applyPosture(): void {
    for (const [name, standing] of Object.entries(STANDING_POSE)) {
      const sitting = SITTING_POSE[name as keyof typeof SITTING_POSE];
      this.pose(name, ...standing.map((value, axis) => value + (sitting[axis] - value) * this.postureMix) as [number, number, number]);
    }
    if (this.vrm) this.vrm.scene.rotation.y = this.modelYaw + this.facingMix * (0.16 + this.postureMix * 0.35);
  }

  private framePosture(): void {
    const vrm = this.vrm;
    if (!vrm) return;
    vrm.scene.position.copy(this.modelOrigin);
    vrm.scene.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(vrm.scene, true);
    const size = bounds.getSize(new Vector3());
    if (bounds.isEmpty() || !Number.isFinite(size.length()) || size.y <= 0) throw new Error('モデルの大きさを確認できませんでした。');
    const center = bounds.getCenter(new Vector3());
    vrm.scene.position.x -= center.x;
    vrm.scene.position.z -= center.z;
    vrm.scene.position.y += -this.standingHeight / 2 - bounds.min.y;
    this.modelWidth = Math.max(this.standingWidth, size.x);
    this.modelHeight = Math.max(this.standingHeight, size.y);
    this.camera.position.z = Math.max(6, size.z + size.y * 3);
    this.camera.far = this.camera.position.z + size.z + size.y * 3;
    this.needsFraming = false;
    this.resize(false);
  }

  /** Accept one short response; repeated calls never queue or prolong it. */
  public call(): boolean {
    if (!this.hasContext() || !this.visible || this.moving || !this.vrm || this.reactionStarted !== null) return false;
    this.reactionExpressionRest = this.reactionExpression
      ? this.vrm.expressionManager?.getValue(this.reactionExpression) ?? 0 : 0;
    this.reactionStarted = performance.now();
    this.diagnostics.reacting = true;
    this.diagnostics.reactionProgress = 0;
    if (this.still()) {
      // Preserve the still bones and spring state. Only the expression is applied,
      // then one timer restores it; reduced motion never starts a render loop.
      this.applyReactionExpression(0.18);
      this.vrm.expressionManager?.update();
      if (!this.renderCurrentFrame()) return false;
      this.reactionTimer = setTimeout(() => {
        this.reactionTimer = null;
        this.cancelReaction(true);
        if (!this.hasContext() || !this.visible || this.moving || !this.vrm) return;
        this.vrm.expressionManager?.update();
        this.renderCurrentFrame();
      }, CALL_RESPONSE_MS);
    } else this.resume();
    return true;
  }

  /** Snapshot only our canvas, once, while its displayed pose stays frozen. */
  public enterMoveMode(): Array<{ x: number; y: number; width: number; height: number }> {
    this.pauseForPlacement();
    // Do not call draw(0): the shaped window must match the frozen pose.
    if (!this.renderCurrentFrame()) throw new Error('描画を確認できませんでした。');
    const gl = this.renderer.getContext();
    if (gl.isContextLost()) throw new Error('描画を確認できませんでした。');
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (width !== window.innerWidth || height !== window.innerHeight) {
      throw new Error('表示倍率の変更が終わってから、もう一度試してください。');
    }
    const pixels = new Uint8Array(width * height * 4);
    // This is our WebGL buffer, never a desktop/screen capture.
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const shape = rgbaToShape(pixels, width, height);
    if (shape.length === 0) throw new Error('しずくの輪郭を確認できませんでした。');
    return shape;
  }

  /** Native pointer placement needs no canvas readback or interactive window. */
  public pauseForPlacement(): void {
    if (!this.hasContext() || !this.visible || !this.vrm) {
      throw new Error('しずくが表示されてから、もう一度試してください。');
    }
    this.pause();
    // Cancel pending work without updating the frozen bones/morph targets. The
    // snapshot below keeps matching the exact displayed pose throughout dragging.
    this.cancelReaction();
    this.moving = true;
    this.diagnostics.moving = true;
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
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private readonly onResize = (): void => this.resize();
  private readonly onContextLost = (event: Event): void => {
    // Allow browser-managed restoration. Three also calls preventDefault.
    event.preventDefault();
    this.suspendForContextLoss();
  };

  private readonly onContextRestored = (): void => {
    if (this.disposed || !this.contextLost || this.renderer.getContext().isContextLost()) return;
    this.contextLost = false;
    this.diagnostics.contextLost = false;
    try {
      // Apply any size changes made while lost, then draw exactly once before
      // restarting the normal timer. Hidden avatars never draw here.
      this.resize(false);
      if (this.visible && !this.vrm && this.hasContext()) this.renderer.clear();
      this.resume();
    } catch {
      // Publish the failure before notifying the renderer. A valid GL context
      // does not guarantee another restoration event after drawing fails.
      this.diagnostics.error = '描画を再開できませんでした。終了して、もう一度起動してください。';
      this.suspendForContextLoss();
      return;
    }
    if (this.hasContext()) this.onContextAvailabilityChanged?.(true);
  };

  private suspendForContextLoss(): void {
    if (this.disposed || this.contextLost) return;
    this.contextLost = true;
    this.diagnostics.contextLost = true;
    this.pause();
    this.cancelReaction();
    this.moving = false;
    this.diagnostics.moving = false;
    this.diagnostics.triangles = 0;
    this.diagnostics.drawCalls = 0;
    this.diagnostics.geometries = 0;
    this.diagnostics.textures = 0;
    this.onContextAvailabilityChanged?.(false);
  }

  private hasContext(): boolean {
    if (this.disposed || this.contextLost) return false;
    // Loss can precede delivery of the DOM event. Stop before updating the VRM,
    // and do not count a render that Three silently skipped during that gap.
    if (this.renderer.getContext().isContextLost()) {
      this.suspendForContextLoss();
      return false;
    }
    return true;
  }

  private readonly onMotionChanged = (): void => {
    this.diagnostics.reducedMotion = this.motion.matches;
    this.pause();
    this.cancelReaction();
    if (this.still()) { this.finishPosture(); this.finishFacing(); }
    this.resume();
  };

  private resize(redraw = true): void {
    if (this.disposed) return;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const available = this.hasContext();
    if (available && (this.renderer.domElement.width !== width || this.renderer.domElement.height !== height)) this.renderer.setSize(width, height, false);
    const frameHeight = this.modelHeight > 0
      ? Math.max(this.modelHeight, this.modelWidth / (width / height)) * 1.12 : 2;
    this.camera.top = frameHeight / 2;
    this.camera.bottom = -this.camera.top;
    this.camera.right = this.camera.top * width / height;
    this.camera.left = -this.camera.right;
    this.camera.updateProjectionMatrix();
    if (available && redraw && this.visible && this.vrm) {
      if (this.moving) this.renderCurrentFrame();
      else this.draw(0);
    }
  }

  private resume(): void {
    if (!this.hasContext() || !this.visible || this.moving || !this.vrm || this.timer !== null) return;
    this.lastFrame = performance.now();
    this.sampleStart = this.lastFrame;
    this.sampleFrames = 0;
    if (!this.draw(0)) return;
    // Reduced-motion mode is a still pose and consumes no repeating render timer.
    if (this.still()) return;
    this.diagnostics.animating = true;
    this.timer = setTimeout(this.tick, Math.ceil(1000 / 30));
  }

  private pause(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.diagnostics.animating = false;
    this.diagnostics.fps = 0;
  }

  private applyReactionExpression(amount: number): void {
    if (this.reactionExpression) {
      const value = this.reactionExpressionRest + (1 - this.reactionExpressionRest) * amount;
      this.vrm?.expressionManager?.setValue(this.reactionExpression, value);
    }
  }

  private cancelReaction(completed = false): void {
    if (this.reactionTimer !== null) clearTimeout(this.reactionTimer);
    this.reactionTimer = null;
    if (this.reactionStarted !== null) this.applyReactionExpression(0);
    this.reactionStarted = null;
    this.diagnostics.reacting = false;
    this.diagnostics.reactionProgress = completed ? 1 : 0;
  }

  private readonly tick = (): void => {
    this.timer = null;
    if (!this.hasContext() || !this.visible || this.moving || !this.vrm || this.still()) return;
    const started = performance.now();
    const delta = Math.min((started - this.lastFrame) / 1000, 0.1);
    this.lastFrame = started;
    this.elapsed += delta;
    if (!this.draw(delta)) return;
    this.sampleFrames += 1;
    if (started - this.sampleStart >= 1000) {
      this.diagnostics.fps = Math.round(this.sampleFrames * 10000 / (started - this.sampleStart)) / 10;
      this.sampleStart = started;
      this.sampleFrames = 0;
    }
    // Schedule after work; never busy-loop or ask for the display's full refresh rate.
    this.timer = setTimeout(this.tick, Math.max(1, Math.ceil(1000 / 30 - (performance.now() - started))));
  };

  private draw(delta: number): boolean {
    const vrm = this.vrm;
    if (!this.hasContext() || !vrm) return false;
    const time = this.still() ? 0 : this.elapsed;
    if (this.diagnostics.changingFacing) {
      this.facingElapsed = Math.min(450, this.facingElapsed + delta * 1000);
      const target = this.facing === 'left' ? -1 : 1;
      this.facingMix = this.facingFrom + (target - this.facingFrom) * postureEase(this.facingElapsed / 450);
      this.diagnostics.changingFacing = this.facingElapsed < 450;
      this.needsFraming = true;
    }
    if (this.diagnostics.changingPosture) {
      this.postureElapsed = Math.min(POSTURE_TRANSITION_MS, this.postureElapsed + delta * 1000);
      const target = this.posture === 'sitting' ? 1 : 0;
      this.postureMix = this.postureFrom + (target - this.postureFrom) * postureEase(this.postureElapsed / POSTURE_TRANSITION_MS);
      this.diagnostics.postureBlend = this.postureMix;
      this.diagnostics.changingPosture = this.postureElapsed < POSTURE_TRANSITION_MS;
      this.needsFraming = true;
    }
    if (this.needsFraming) this.applyPosture();
    let nod = 0;
    let turn = 0;
    let tilt = 0;
    if (this.reactionStarted !== null && !this.still()) {
      const reaction = sampleCallResponse(performance.now() - this.reactionStarted);
      this.diagnostics.reactionProgress = reaction.progress;
      ({ nod, turn, tilt } = reaction);
      this.applyReactionExpression(reaction.expression);
      if (reaction.done) this.cancelReaction(true);
    }
    this.pose(VRMHumanBoneName.Head, Math.sin(time * 0.53) * 0.008 + nod,
      -this.facingMix * (0.07 + this.postureMix * 0.2) + Math.sin(time * 0.23) * 0.025 + turn, Math.sin(time * 0.31) * 0.012 + tilt);
    this.pose(VRMHumanBoneName.Chest, Math.sin(time * 1.35) * 0.004, 0, 0);
    const blinkPhase = (time + 1.8) % 5.6;
    const blink = !this.still() && blinkPhase < 0.18
      ? Math.sin(blinkPhase / 0.18 * Math.PI) : 0;
    for (const name of this.blinkNames) vrm.expressionManager?.setValue(name, blink);
    vrm.update(delta);
    // Precise skin bounds are measured only while changing pose (about 700 ms),
    // never in the steady idle loop. This keeps bent knees/feet inside the canvas.
    if (this.needsFraming) this.framePosture();
    return this.renderCurrentFrame();
  }

  private renderCurrentFrame(): boolean {
    if (!this.hasContext()) return false;
    this.renderer.render(this.scene, this.camera);
    if (!this.hasContext()) return false;
    this.diagnostics.renderedFrames += 1;
    this.diagnostics.triangles = this.renderer.info.render.triangles;
    this.diagnostics.drawCalls = this.renderer.info.render.calls;
    this.diagnostics.geometries = this.renderer.info.memory.geometries;
    this.diagnostics.textures = this.renderer.info.memory.textures;
    // A bone-derived seat reference, not recognition of any other window. Offset
    // slightly below the hips to approximate the contact surface of the body.
    const hips = this.vrm?.humanoid.getRawBoneNode(VRMHumanBoneName.Hips);
    this.diagnostics.seatAnchor = null;
    if (hips && this.postureMix === 1 && !this.diagnostics.changingFacing) {
      const point = hips.getWorldPosition(new Vector3());
      point.y -= this.standingHeight * 0.07;
      point.project(this.camera);
      const x = (point.x + 1) / 2, y = (1 - point.y) / 2;
      if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1) this.diagnostics.seatAnchor = { x, y };
    }
    this.onFrame?.();
    return true;
  }

  private pose(name: string, x: number, y: number, z: number): void {
    const binding = this.bones.get(name);
    if (!binding) return;
    this.euler.set(x, y, z, 'YXZ');
    this.rotation.setFromEuler(this.euler);
    binding.node.quaternion.copy(binding.rest).multiply(this.rotation);
  }
}

async function parseModel(buffer: ArrayBuffer, images: ModelImages): Promise<VRM> {
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
    trackModelImages(parser, images);
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
    images.dispose();
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
