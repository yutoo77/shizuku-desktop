import type { GLTFParser } from 'three/addons/loaders/GLTFLoader.js';

export type TextureQuality = 'original' | 'compact';
type ResizeBitmap = (image: ImageBitmap, options: ImageBitmapOptions) => Promise<ImageBitmap>;
type ModelImage = Pick<ImageBitmap, 'close'>;
type ImageState = { owners: number; closed: boolean };
const imageStates = new WeakMap<ModelImage, ImageState>();

/** CPU image resources belong to one model load, including unfinished decodes. */
export class ModelImages {
  private readonly images = new Set<ModelImage>();
  private readonly seen = new WeakSet<ModelImage>();
  private disposed = false;
  public resizedCount = 0;
  public fallbackCount = 0;

  public get isDisposed(): boolean { return this.disposed; }

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
 * Compact mode retains only the resized bitmap for context recovery. The full
 * decode stays alive until resizing settles, so this reduces resident resources,
 * not the peak required to decode a model. GLTF's parse promise waits for our
 * callback; the ImageBitmapLoader's manager item ends before asynchronous resize.
 */
export function trackModelImages(
  parser: Pick<GLTFParser, 'textureLoader'>,
  images: ModelImages,
  textureQuality: TextureQuality = 'original',
  resizeBitmap: ResizeBitmap = (image, options) => createImageBitmap(image, options),
): void {
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
    const deliver = (image: ImageBitmap) => {
      images.track(image);
      onLoad?.(image);
      completed = true;
    };
    const fail = (error: unknown) => {
      releaseFailedURL();
      onError?.(error);
    };
    try {
      return load(url, image => {
        if (textureQuality !== 'compact' || images.isDisposed || Math.max(image.width, image.height) <= 1024) {
          deliver(image);
          return;
        }

        // Another model may share this image. A temporary owner, rather than a
        // direct close(), keeps that owner's original image valid throughout.
        const originalOwner = new ModelImages();
        originalOwner.track(image);
        let conversion: Promise<ImageBitmap>;
        try {
          conversion = resizeBitmap(image, {
            ...(image.width >= image.height ? { resizeWidth: 1024 } : { resizeHeight: 1024 }),
            // Orientation was already applied during Three's original decode.
            imageOrientation: 'from-image',
            premultiplyAlpha: 'none',
            colorSpaceConversion: 'none',
            resizeQuality: 'high',
          });
        } catch {
          // Starting a resize can throw as well as return a rejected promise.
          try {
            images.fallbackCount += 1;
            deliver(image);
          } finally {
            originalOwner.dispose();
          }
          return;
        }

        const finishResize = (result: ImageBitmap, resized: boolean) => {
          try {
            if (resized) images.resizedCount += 1;
            else images.fallbackCount += 1;
            // A disposed model closes a late result while still letting GLTF's
            // normal callback complete its object-URL and parse cleanup.
            deliver(result);
          } catch (error) {
            // A consumer callback error is not a resize failure: never deliver a
            // second success with the original bitmap in this case.
            try { fail(error); }
            catch (callbackError) {
              // An asynchronous equivalent of throwing from the loader callback,
              // reported without leaving an unhandled resize promise rejection.
              globalThis.reportError(callbackError);
            }
          } finally {
            originalOwner.dispose();
          }
        };
        // Three does not await its onLoad return value. Own both outcomes here
        // instead of returning an async callback whose rejection would be lost.
        void conversion.then(result => finishResize(result, true), () => finishResize(image, false));
      }, onProgress, fail);
    } catch (error) {
      // URL resolution or starting the loader can also throw before a callback.
      releaseFailedURL();
      throw error;
    }
  };
}
