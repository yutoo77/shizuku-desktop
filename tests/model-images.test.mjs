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

test('successful decoding tracks the image and leaves URL cleanup to the parser', t => {
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
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
      assert.equal(typeof onError, 'function');
      finish = onLoad;
    },
  };
  trackModelImages({ textureLoader: loader }, images);
  let received;
  loader.load('blob:model-image', image => { received = image; }, progress, failure);
  assert.equal(revoke.mock.callCount(), 0);
  finish(decoded);
  assert.equal(received, decoded);
  assert.equal(decoded.closes, 0);
  assert.equal(revoke.mock.callCount(), 0);
  images.dispose();
  assert.equal(decoded.closes, 1);
  assert.equal(revoke.mock.callCount(), 0);
});

test('failed blob decoding releases its URL once and forwards original errors', t => {
  const revoked = [];
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  let fail;
  const loader = {
    isImageBitmapLoader: true,
    load(_url, _onLoad, _onProgress, onError) { fail = onError; },
  };
  trackModelImages({ textureLoader: loader }, new ModelImages());
  const failures = [];
  const error = new Error('synthetic decode failure');
  loader.load('blob:broken-image', undefined, undefined, received => {
    assert.deepEqual(revoked, ['blob:broken-image']);
    failures.push(received);
  });
  fail(error);
  fail(error);
  assert.deepEqual(revoked, ['blob:broken-image']);
  assert.equal(failures.length, 2);
  assert.ok(failures.every(received => received === error));
});

test('non-blob errors are forwarded without revoking other URL types', t => {
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
  const error = { reason: 'synthetic failure' };
  const loader = {
    isImageBitmapLoader: true,
    load(_url, _onLoad, _onProgress, onError) { onError(error); },
  };
  trackModelImages({ textureLoader: loader }, new ModelImages());
  let failures = 0;
  // The adapter does not grant network access; this loader is an isolated fake.
  for (const url of ['data:image/png;base64,invalid', 'https://example.invalid/image', 'image.png']) {
    loader.load(url, undefined, undefined, received => {
      assert.equal(received, error);
      failures += 1;
    });
  }
  assert.equal(failures, 3);
  assert.equal(revoke.mock.callCount(), 0);
});

test('a missing error callback does not prevent failed blob cleanup', t => {
  const revoked = [];
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const loader = {
    isImageBitmapLoader: true,
    load(_url, _onLoad, _onProgress, onError) { onError(new Error('synthetic failure')); },
  };
  trackModelImages({ textureLoader: loader }, new ModelImages());
  assert.doesNotThrow(() => loader.load('blob:no-error-handler'));
  assert.deepEqual(revoked, ['blob:no-error-handler']);
});

test('synchronous loader failure releases the blob and throws the same error', t => {
  const revoked = [];
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const error = new Error('synthetic loader startup failure');
  const loader = {
    isImageBitmapLoader: true,
    load() { throw error; },
  };
  trackModelImages({ textureLoader: loader }, new ModelImages());
  let callbackCalls = 0;
  assert.throws(() => loader.load('blob:startup-failure', undefined, undefined, () => {
    callbackCalls += 1;
  }), received => received === error);
  assert.deepEqual(revoked, ['blob:startup-failure']);
  assert.equal(callbackCalls, 0);
});

test('an error callback that throws does not cause duplicate URL release', t => {
  const revoked = [];
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const error = new Error('synthetic decode failure');
  const callbackError = new Error('synthetic callback failure');
  const loader = {
    isImageBitmapLoader: true,
    load(_url, _onLoad, _onProgress, onError) { onError(error); },
  };
  trackModelImages({ textureLoader: loader }, new ModelImages());
  assert.throws(() => loader.load('blob:callback-failure', undefined, undefined, received => {
    assert.equal(received, error);
    throw callbackError;
  }), received => received === callbackError);
  assert.deepEqual(revoked, ['blob:callback-failure']);
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
