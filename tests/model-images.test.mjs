import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelImages, trackModelImages } from '../src/model-images.ts';

function bitmap() {
  return { closes: 0, close() { this.closes += 1; } };
}

test('model images close once despite duplicate textures and repeated disposal', () => {
  const images = new ModelImages();
  const shared = bitmap();
  images.track(shared);
  images.track(shared);
  images.dispose();
  images.dispose();
  images.track(shared);
  assert.equal(shared.closes, 1);
});

test('disposing one model leaves another active owner of a shared image intact', () => {
  const previous = new ModelImages();
  const current = new ModelImages();
  const shared = bitmap();
  previous.track(shared);
  current.track(shared);
  previous.dispose();
  assert.equal(shared.closes, 0);
  current.dispose();
  assert.equal(shared.closes, 1);
  assert.throws(() => new ModelImages().track(shared), /released model image/);
});

test('late decode closes immediately after cancellation and cannot close a different model image', () => {
  const obsolete = new ModelImages();
  const current = new ModelImages();
  const late = bitmap();
  const active = bitmap();
  obsolete.dispose();
  current.track(active);
  obsolete.track(late);
  obsolete.track(late);
  obsolete.track(active);
  assert.equal(late.closes, 1);
  assert.equal(active.closes, 0);
  current.dispose();
  assert.equal(active.closes, 1);
});

test('the parser-local adapter tracks decoded images before forwarding unchanged callbacks', () => {
  const images = new ModelImages();
  const decoded = bitmap();
  let finish;
  const progress = () => {};
  const failure = () => {};
  const loader = {
    isImageBitmapLoader: true,
    load(url, onLoad, onProgress, onError) {
      assert.equal(this, loader);
      assert.equal(url, 'blob:model-image');
      assert.equal(onProgress, progress);
      assert.equal(onError, failure);
      finish = onLoad;
    },
  };
  trackModelImages({ textureLoader: loader }, images);
  let received;
  loader.load('blob:model-image', image => { received = image; }, progress, failure);
  finish(decoded);
  assert.equal(received, decoded);
  assert.equal(decoded.closes, 0);
  images.dispose();
  assert.equal(decoded.closes, 1);
});

test('a failed parse still releases later decodes while allowing parser cleanup to finish', () => {
  const images = new ModelImages();
  const decoded = bitmap();
  let finish;
  const loader = {
    isImageBitmapLoader: true,
    load(_url, onLoad) { finish = onLoad; },
  };
  trackModelImages({ textureLoader: loader }, images);
  let cleanupRan = false;
  loader.load('blob:late-image', image => {
    assert.equal(image, decoded);
    cleanupRan = true;
  });
  images.dispose();
  finish(decoded);
  assert.equal(decoded.closes, 1);
  assert.equal(cleanupRan, true);
});

test('fallback texture loaders and unrelated model loaders are unchanged', () => {
  const fallback = { load() {} };
  const unrelated = { isImageBitmapLoader: true, load() {} };
  const fallbackLoad = fallback.load;
  const unrelatedLoad = unrelated.load;
  trackModelImages({ textureLoader: fallback }, new ModelImages());
  assert.equal(fallback.load, fallbackLoad);
  assert.equal(unrelated.load, unrelatedLoad);
});
