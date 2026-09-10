import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';

type ModelImage = Pick<ImageBitmap, 'close'>;
type ImageState = { owners: number; closed: boolean };
const imageStates = new WeakMap<ModelImage, ImageState>();

/** CPU image resources belong to one model load, including unfinished decodes. */
export class ModelImages {
  private readonly images = new Set<ModelImage>();
  private readonly seen = new WeakSet<ModelImage>();
  private disposed = false;

  public track(image: ModelImage): void {
    if (this.seen.has(image)) return;
    this.seen.add(image);
    let state = imageStates.get(image);
    if (!state) {
      state = { owners: 0, closed: false };
      imageStates.set(image, state);
    }
    if (this.disposed) {
      // The parse can finish decoding after it failed or was superseded.
      this.closeIfUnused(image, state);
      return;
    }
    if (state.closed) throw new Error('A released model image cannot be reused.');
    state.owners += 1;
    this.images.add(image);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const image of this.images) {
      const state = imageStates.get(image)!;
      state.owners -= 1;
      this.closeIfUnused(image, state);
    }
    this.images.clear();
  }

  private closeIfUnused(image: ModelImage, state: ImageState): void {
    if (state.owners !== 0 || state.closed) return;
    state.closed = true;
    image.close();
  }
}

/**
 * Local adapter for the pinned Three r185 GLTFParser.textureLoader implementation.
 * GLTFLoader creates a separate loader per parse. Watching decoded images here
 * also covers unused textures and failures before a scene exists; scene traversal
 * cannot. No global ImageBitmap/loader behavior is changed. The normal parser
 * callback still runs for an obsolete load so its object-URL cleanup can finish.
 * This adapter is used only after embedded-resource validation: input blob URLs
 * are rejected, so a blob URL reaching this loader belongs to GLTFLoader. Three
 * r185 revokes those URLs on success only; release them here on decode failure.
 */
export function trackModelImages(parser: Pick<GLTFParser, 'textureLoader'>, images: ModelImages): void {
  const loader = parser.textureLoader;
  if (!('isImageBitmapLoader' in loader) || loader.isImageBitmapLoader !== true) return;
  const load = loader.load.bind(loader);
  loader.load = (url, onLoad, onProgress, onError) => {
    let completed = false;
    let released = false;
    const releaseFailedURL = () => {
      if (completed || released || !url.startsWith('blob:')) return;
      released = true;
      URL.revokeObjectURL(url);
    };
    try {
      return load(url, image => {
        images.track(image);
        onLoad?.(image);
        completed = true;
      }, onProgress, error => {
        releaseFailedURL();
        onError?.(error);
      });
    } catch (error) {
      // URL resolution or starting the loader can also throw before a callback.
      releaseFailedURL();
      throw error;
    }
  };
}
