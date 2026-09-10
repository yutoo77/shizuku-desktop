import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelImages, trackModelImages } from '../src/model-images.ts';

function bitmap(width = 2048, height = 2048) {
  return { width, height, closes: 0, close() { this.closes += 1; } };
}

function deferredBitmapLoader() {
  let finish;
  return {
    loader: { isImageBitmapLoader: true, load(_url, onLoad) { finish = onLoad; } },
    finish(image) { finish(image); },
  };
}

const settleCallbacks = () => new Promise(resolve => setImmediate(resolve));

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

test('original quality and already-small compact images are delivered without conversion', () => {
  for (const [quality, width, height] of [['original', 4096, 2048], ['compact', 1024, 512], ['compact', 2, 1024]]) {
    const images = new ModelImages();
    const { loader, finish } = deferredBitmapLoader();
    const original = bitmap(width, height);
    let resizeCalls = 0;
    let received;
    trackModelImages({ textureLoader: loader }, images, quality, () => { resizeCalls += 1; });
    loader.load('blob:unchanged-image', image => { received = image; });
    finish(original);
    assert.equal(received, original);
    assert.equal(resizeCalls, 0);
    assert.equal(images.resizedCount, 0);
    assert.equal(images.fallbackCount, 0);
    images.dispose();
    assert.equal(images.isDisposed, true);
    assert.equal(original.closes, 1);
  }
});

test('compact conversion constrains the long axis and retains only its replacement', async t => {
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
  for (const [width, height, expectedAxis] of [[2048, 2048, 'resizeWidth'], [4096, 2048, 'resizeWidth'], [1024, 4096, 'resizeHeight']]) {
    const images = new ModelImages();
    const { loader, finish } = deferredBitmapLoader();
    const original = bitmap(width, height);
    const reduced = bitmap(1024, 1024);
    let received;
    let resizeCalls = 0;
    trackModelImages({ textureLoader: loader }, images, 'compact', (source, options) => {
      resizeCalls += 1;
      assert.equal(source, original);
      assert.deepEqual(options, {
        [expectedAxis]: 1024,
        imageOrientation: 'from-image',
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
        resizeQuality: 'high',
      });
      assert.equal(original.closes, 0);
      return Promise.resolve(reduced);
    });
    loader.load('blob:compact-image', image => { received = image; });
    finish(original);
    assert.equal(received, undefined);
    await settleCallbacks();
    assert.equal(received, reduced);
    assert.equal(resizeCalls, 1);
    assert.equal(images.resizedCount, 1);
    assert.equal(images.fallbackCount, 0);
    assert.equal(original.closes, 1);
    assert.equal(reduced.closes, 0);
    images.dispose();
    assert.equal(reduced.closes, 1);
  }
  assert.equal(revoke.mock.callCount(), 0, 'successful loads leave blob cleanup to GLTFParser');
});

test('disposing during compact conversion releases its late result after parser delivery', async () => {
  const images = new ModelImages();
  const { loader, finish } = deferredBitmapLoader();
  const original = bitmap();
  const reduced = bitmap(1024, 1024);
  let resolveConversion;
  let cleanupCalls = 0;
  trackModelImages({ textureLoader: loader }, images, 'compact', () => new Promise(resolve => { resolveConversion = resolve; }));
  loader.load('blob:pending-image', image => {
    assert.equal(image, reduced);
    assert.equal(image.closes, 1);
    cleanupCalls += 1;
  });
  finish(original);
  images.dispose();
  assert.equal(original.closes, 0, 'the conversion still owns its full-size source');
  resolveConversion(reduced);
  await settleCallbacks();
  assert.equal(cleanupCalls, 1);
  assert.equal(original.closes, 1);
  assert.equal(reduced.closes, 1);
  images.dispose();
  assert.equal(reduced.closes, 1);
});

test('compact mode does not begin conversion for an already-obsolete model', () => {
  const images = new ModelImages();
  const { loader, finish } = deferredBitmapLoader();
  const original = bitmap();
  let resizeCalls = 0;
  let cleanupCalls = 0;
  trackModelImages({ textureLoader: loader }, images, 'compact', () => { resizeCalls += 1; });
  loader.load('blob:obsolete-image', image => {
    assert.equal(image, original);
    cleanupCalls += 1;
  });
  images.dispose();
  finish(original);
  assert.equal(resizeCalls, 0);
  assert.equal(cleanupCalls, 1);
  assert.equal(original.closes, 1);
});

test('compact conversion cannot release an original still owned by another model', async () => {
  const current = new ModelImages();
  const other = new ModelImages();
  const { loader, finish } = deferredBitmapLoader();
  const shared = bitmap();
  const reduced = bitmap(1024, 1024);
  other.track(shared);
  trackModelImages({ textureLoader: loader }, current, 'compact', () => Promise.resolve(reduced));
  loader.load('blob:shared-image', () => {});
  finish(shared);
  await settleCallbacks();
  assert.equal(shared.closes, 0);
  current.dispose();
  assert.equal(reduced.closes, 1);
  assert.equal(shared.closes, 0);
  other.dispose();
  assert.equal(shared.closes, 1);
});

test('failed compact conversion falls back to the original without losing parser cleanup', async t => {
  const revoke = t.mock.method(URL, 'revokeObjectURL', () => {});
  for (const synchronous of [false, true]) {
    const images = new ModelImages();
    const { loader, finish } = deferredBitmapLoader();
    const original = bitmap();
    const error = new Error('synthetic resize failure');
    let received;
    let failureCalls = 0;
    trackModelImages({ textureLoader: loader }, images, 'compact', () => {
      if (synchronous) throw error;
      return Promise.reject(error);
    });
    loader.load('blob:resize-fallback', image => { received = image; }, undefined, () => { failureCalls += 1; });
    finish(original);
    await settleCallbacks();
    assert.equal(received, original);
    assert.equal(original.closes, 0);
    assert.equal(failureCalls, 0);
    assert.equal(images.resizedCount, 0);
    assert.equal(images.fallbackCount, 1);
    images.dispose();
    assert.equal(original.closes, 1);
  }
  assert.equal(revoke.mock.callCount(), 0);
});

test('a failed conversion after disposal closes its fallback and still finishes parser cleanup', async () => {
  const images = new ModelImages();
  const { loader, finish } = deferredBitmapLoader();
  const original = bitmap();
  let rejectConversion;
  let cleanupCalls = 0;
  trackModelImages({ textureLoader: loader }, images, 'compact', () => new Promise((_resolve, reject) => { rejectConversion = reject; }));
  loader.load('blob:cancelled-fallback', image => {
    assert.equal(image, original);
    cleanupCalls += 1;
  });
  finish(original);
  images.dispose();
  rejectConversion(new Error('synthetic failure after disposal'));
  await settleCallbacks();
  assert.equal(cleanupCalls, 1);
  assert.equal(original.closes, 1);
  assert.equal(images.fallbackCount, 1);
});

test('compact success callback errors are forwarded once without a second success or fallback', async t => {
  const revoked = [];
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const images = new ModelImages();
  const { loader, finish } = deferredBitmapLoader();
  const original = bitmap();
  const reduced = bitmap(1024, 1024);
  const callbackError = new Error('synthetic success callback failure');
  let successCalls = 0;
  const failures = [];
  trackModelImages({ textureLoader: loader }, images, 'compact', () => Promise.resolve(reduced));
  loader.load('blob:compact-callback-error', () => {
    successCalls += 1;
    throw callbackError;
  }, undefined, error => { failures.push(error); });
  finish(original);
  await settleCallbacks();
  assert.equal(successCalls, 1);
  assert.deepEqual(failures, [callbackError]);
  assert.deepEqual(revoked, ['blob:compact-callback-error']);
  assert.equal(images.fallbackCount, 0);
  assert.equal(original.closes, 1);
  images.dispose();
  assert.equal(reduced.closes, 1);
});

test('an asynchronous error-handler exception is reported without abandoning a rejected resize promise', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'reportError');
  const reported = [];
  Object.defineProperty(globalThis, 'reportError', { configurable: true, value: error => reported.push(error) });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'reportError', descriptor);
    else delete globalThis.reportError;
  });
  const images = new ModelImages();
  const { loader, finish } = deferredBitmapLoader();
  const original = bitmap();
  const reduced = bitmap(1024, 1024);
  const handlerError = new Error('synthetic error-handler failure');
  trackModelImages({ textureLoader: loader }, images, 'compact', () => Promise.resolve(reduced));
  loader.load('blob:error-handler-error', () => { throw new Error('synthetic success failure'); }, undefined, () => { throw handlerError; });
  finish(original);
  await settleCallbacks();
  assert.deepEqual(reported, [handlerError]);
  assert.equal(original.closes, 1);
  images.dispose();
  assert.equal(reduced.closes, 1);
});
