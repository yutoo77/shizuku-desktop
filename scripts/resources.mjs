// Exercise real ImageBitmaps and loader-created Blob URLs without copying models
// or using native input. The broken GLB is synthetic and exists only in memory.
import { _electron } from 'playwright';
import electron from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normal = path.join(root, 'local.config.json');
const before = await readFile(normal);
const config = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
assert.ok(typeof config.modelPath === 'string' && config.modelPath, 'Select a local VRM before running resource checks.');
const directory = await mkdtemp(path.join(root, 'work', 'resources-'));
await writeFile(path.join(directory, 'local.config.json'), JSON.stringify({ modelPath: config.modelPath, scale: 100, quiet: true }));
const env = { ...process.env, SHIZUKU_TEST: '1', SHIZUKU_TEST_DATA: path.basename(directory), SHIZUKU_METRICS: '0' };
delete env.OPENAI_API_KEY;
delete env.ELECTRON_RUN_AS_NODE;
let application, page, failure;
const pids = new Set();
const report = { startedAt: new Date().toISOString(), status: 'running', results: [], brokenLoads: [], perModel: null, overlap: null, restored: null, cleared: null, remainingPids: null, userSettingsUnchanged: null };

// Generate a valid RGBA PNG, including its checksums, without an asset file.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type), chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length); name.copy(chunk, 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}
function brokenTextureGLB() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const valid = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 60, 120, 210, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
  const corrupted = Buffer.from('This synthetic PNG intentionally cannot decode.');
  const positions = Buffer.from(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0]).buffer);
  const uv = Buffer.from(new Float32Array([0, 0, 1, 0, 0.5, 1]).buffer);
  const parts = [], views = [];
  let byteLength = 0;
  for (const part of [positions, uv, valid, corrupted]) {
    views.push({ buffer: 0, byteOffset: byteLength, byteLength: part.length });
    const padded = Buffer.alloc(Math.ceil(part.length / 4) * 4); part.copy(padded);
    parts.push(padded); byteLength += padded.length;
  }
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ byteLength }], bufferViews: views,
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.5, 0, 0], max: [0.5, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
    images: [{ bufferView: 2, mimeType: 'image/png' }, { bufferView: 3, mimeType: 'image/png' }],
    textures: [{ source: 0 }, { source: 1 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
  };
  const encoded = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20); encoded.copy(padded);
  const container = Buffer.alloc(12 + 8 + padded.length + 8 + byteLength);
  container.writeUInt32LE(0x46546c67, 0); container.writeUInt32LE(2, 4); container.writeUInt32LE(container.length, 8);
  container.writeUInt32LE(padded.length, 12); container.writeUInt32LE(0x4e4f534a, 16); padded.copy(container, 20);
  container.writeUInt32LE(byteLength, 20 + padded.length); container.writeUInt32LE(0x004e4942, 24 + padded.length);
  Buffer.concat(parts).copy(container, 28 + padded.length);
  return container;
}
async function recordPids() {
  if (!application) return;
  pids.add(application.process().pid);
  const state = await application.evaluate(() => ({ processes: __shizuku.metrics(), helper: __shizuku.tracking().pid }));
  for (const item of state.processes) pids.add(item.pid);
  if (Number.isSafeInteger(state.helper) && state.helper > 0) pids.add(state.helper);
}
const snapshots = () => page.evaluate(() => {
  const p = window.__bitmapProbe;
  return { images: p.images.map(x => ({ ...x })), urls: p.urls.map(x => ({ ...x })), decodes: p.decodes.map(x => ({ ...x })),
    inFlight: p.inFlight, unknownRevocations: p.unknownRevocations, textures: window.__diagnostics.textures };
});
async function beginReload(generation) {
  await page.evaluate(n => { window.__bitmapProbe.generation = n; }, generation);
  await application.evaluate(() => __shizuku.avatar().webContents.send('model:changed'));
}
const waitLoaded = generation => page.waitForFunction(n => window.__diagnostics.loaded
  && window.__bitmapProbe.images.some(x => x.generation === n), generation, { timeout: 20_000 });
const summary = state => ({ created: state.images.length, closed: state.images.filter(x => x.closed === 1).length,
  open: state.images.filter(x => x.closed === 0).length, createdURLs: state.urls.length,
  revokedURLs: state.urls.filter(x => x.revoked === 1).length, inFlight: state.inFlight, textures: state.textures });

try {
  application = await _electron.launch({ executablePath: electron, args: [root], cwd: root, env });
  pids.add(application.process().pid);
  page = await application.firstWindow();
  await page.waitForFunction(() => window.__diagnostics?.loaded, null, { timeout: 20_000 });
  await recordPids();
  await page.evaluate(() => {
    const create = window.createImageBitmap, close = ImageBitmap.prototype.close;
    const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
    const ids = new WeakMap(), urls = new Map();
    const probe = window.__bitmapProbe = { generation: 0, hold: false, pending: [], images: [], urls: [], decodes: [], inFlight: 0, unknownRevocations: 0 };
    URL.createObjectURL = function(blob) {
      const url = createURL(blob), record = { id: probe.urls.length, generation: probe.generation, revoked: 0 };
      urls.set(url, record); probe.urls.push(record); return url;
    };
    URL.revokeObjectURL = function(url) {
      const record = urls.get(url);
      if (record) record.revoked++; else probe.unknownRevocations++;
      return revokeURL(url);
    };
    window.createImageBitmap = async function(...args) {
      const generation = probe.generation, decode = { generation, status: 'pending' };
      probe.decodes.push(decode); probe.inFlight++;
      try {
        const bitmap = await create.apply(this, args);
        decode.status = 'success';
        const record = { id: probe.images.length, generation, width: bitmap.width, height: bitmap.height, closed: 0 };
        probe.images.push(record); ids.set(bitmap, record);
        if (probe.hold) await new Promise(resolve => probe.pending.push(resolve));
        return bitmap;
      } catch (error) { decode.status = 'error'; throw error; }
      finally { probe.inFlight--; }
    };
    ImageBitmap.prototype.close = function() {
      const record = ids.get(this); if (record) record.closed++;
      return close.call(this);
    };
  });
  for (let generation = 1; generation <= 3; generation++) {
    await beginReload(generation); await waitLoaded(generation);
    const state = await snapshots(), current = state.images.filter(x => x.generation === generation);
    assert.ok(current.length > 0, 'Resource checks require a VRM using ImageBitmap textures.');
    report.perModel ??= current.length;
    assert.equal(current.length, report.perModel);
    assert.ok(current.every(x => x.closed === 0), 'Current model images must remain usable.');
    assert.ok(state.images.filter(x => x.generation < generation).every(x => x.closed === 1), 'Discarded model images must be closed once.');
    assert.ok(state.urls.every(x => x.revoked === 1), 'Successful parsing releases every created Blob URL once.');
    report.results.push({ generation, ...summary(state) });
  }
  // Hold decoded images from one model until a newer load has completed.
  await page.evaluate(() => { window.__bitmapProbe.hold = true; });
  await beginReload(4);
  await page.waitForFunction(() => window.__bitmapProbe.pending.length > 0, null, { timeout: 10_000 });
  await page.evaluate(() => { window.__bitmapProbe.hold = false; });
  await beginReload(5); await waitLoaded(5);
  const currentIds = (await snapshots()).images.filter(x => x.generation === 5 && x.closed === 0).map(x => x.id);
  assert.equal(currentIds.length, report.perModel);
  await page.evaluate(() => { for (const resolve of window.__bitmapProbe.pending.splice(0)) resolve(); });
  await page.waitForFunction(() => window.__bitmapProbe.images.filter(x => x.generation === 4).every(x => x.closed === 1), null, { timeout: 10_000 });
  // An obsolete parser can enter later texture stages after its held callbacks.
  // Track the completed current model by image IDs, not a global generation.
  await delay(1000);
  const overlap = await snapshots();
  assert.ok(overlap.images.filter(x => currentIds.includes(x.id)).every(x => x.closed === 0));
  assert.ok(overlap.images.filter(x => !currentIds.includes(x.id)).every(x => x.closed === 1));
  assert.ok(overlap.urls.every(x => x.revoked === 1));
  assert.equal(overlap.inFlight, 0);
  assert.equal(await page.evaluate(() => window.__diagnostics.loaded), true);
  report.overlap = summary(overlap);
  const capture = async name => {
    const image = await application.evaluate(async () => (await __shizuku.avatar().webContents.capturePage()).toPNG().toString('base64'));
    await writeFile(path.join(directory, name), Buffer.from(image, 'base64'));
  };
  await capture('after-reloads.png');

  // This test-only injection reaches the real parser. It bypasses the main
  // format gate only for a synthetic non-VRM GLB; normal selected-file reads
  // retain the original handler and all of its sender/resource validation.
  await application.evaluate(({ ipcMain }, bytes) => {
    const original = ipcMain._invokeHandlers.get('model:read');
    if (!original) throw new Error('Missing model read handler');
    globalThis.__resourceReadProbe = { original, broken: Uint8Array.from(bytes) };
    ipcMain.removeHandler('model:read');
    ipcMain.handle('model:read', () => __resourceReadProbe.broken.slice().buffer);
  }, Array.from(brokenTextureGLB()));
  for (let generation = 6; generation <= 8; generation++) {
    await beginReload(generation);
    await page.waitForFunction(n => {
      const p = window.__bitmapProbe, own = p.decodes.filter(x => x.generation === n);
      return p.inFlight === 0 && own.some(x => x.status === 'error') && own.some(x => x.status === 'success')
        && !window.__diagnostics.loaded && !!window.__diagnostics.error;
    }, generation, { timeout: 10_000 });
    // loadTextureImage catches decode errors and substitutes null. The eventual
    // unsupported-VRM error does not prove decoding failed; assert both facts.
    const state = await snapshots(), urls = state.urls.filter(x => x.generation === generation);
    const decodes = state.decodes.filter(x => x.generation === generation);
    assert.equal(decodes.filter(x => x.status === 'error').length, 1, 'Corrupted PNG reaches and fails the actual browser decoder.');
    assert.equal(decodes.filter(x => x.status === 'success').length, 1, 'The valid fixture PNG decodes successfully.');
    assert.equal(urls.length, 2, 'Each embedded fixture image receives its own loader-created Blob URL.');
    assert.ok(urls.every(x => x.revoked === 1), 'Both successful and rejected image Blob URLs must be revoked once.');
    assert.ok(state.images.every(x => x.closed === 1), 'Failed scene parsing closes every successfully decoded image, including previous models.');
    assert.equal(state.unknownRevocations, 0, 'No foreign URL may be revoked.');
    report.brokenLoads.push({ generation, successfulDecodes: 1, rejectedDecodes: 1, fixtureCreatedURLs: urls.length,
      fixtureRevokedURLs: urls.filter(x => x.revoked === 1).length, ...summary(state) });
  }
  await application.evaluate(({ ipcMain }) => {
    const original = __resourceReadProbe.original;
    ipcMain.removeHandler('model:read'); ipcMain.handle('model:read', original);
    delete globalThis.__resourceReadProbe;
  });
  await beginReload(9); await waitLoaded(9);
  const restored = await snapshots();
  assert.equal(restored.images.filter(x => x.generation === 9 && x.closed === 0).length, report.perModel);
  assert.equal(restored.textures, report.results[0].textures);
  assert.ok(restored.images.filter(x => x.generation !== 9).every(x => x.closed === 1));
  assert.ok(restored.urls.every(x => x.revoked === 1));
  assert.equal(restored.inFlight, 0); assert.equal(restored.unknownRevocations, 0);
  report.restored = summary(restored);
  await capture('after-broken-loads.png');
  await recordPids();

  // Empty input exercises clear without changing the saved user selection.
  await application.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('model:read'); ipcMain.handle('model:read', () => null);
    __shizuku.avatar().webContents.send('model:changed');
  });
  await page.waitForFunction(() => !window.__diagnostics.loaded && window.__bitmapProbe.images.every(x => x.closed === 1), null, { timeout: 5000 });
  const cleared = await snapshots();
  assert.ok(cleared.urls.every(x => x.revoked === 1));
  assert.equal(cleared.inFlight, 0);
  report.cleared = summary(cleared);
  report.status = 'passed';
} catch (error) {
  failure = error; report.status = 'failed'; report.failure = error instanceof Error ? error.message : String(error);
  if (page) { try { report.failureProbe = await snapshots(); } catch { /* Renderer may already have exited. */ } }
} finally {
  if (application) {
    try { await recordPids(); } catch { /* Keep the launch PID if the app stopped early. */ }
    try { await application.close(); }
    catch (error) { failure ??= error; report.status = 'failed'; report.cleanupFailure = error instanceof Error ? error.message : String(error); }
    application = null;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    report.remainingPids = [...pids].filter(pid => {
      try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
    });
    if (!report.remainingPids.length) break;
    await delay(250);
  }
  try { report.userSettingsUnchanged = (await readFile(normal)).equals(before); }
  catch (error) { report.settingsReadFailure = String(error); }
  if (report.remainingPids.length || !report.userSettingsUnchanged) {
    failure ??= new Error('Resource-check cleanup or normal-settings comparison failed.'); report.status = 'failed';
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  // Detailed per-image failure probes stay in the report instead of flooding stdout.
  const { failureProbe, ...brief } = report;
  console.log(JSON.stringify({ directory, ...brief }, null, 2));
}
if (failure) throw failure;
