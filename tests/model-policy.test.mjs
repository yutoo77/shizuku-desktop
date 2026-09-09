import test from 'node:test';
import assert from 'node:assert/strict';
import { validateModel } from '../src/model-policy.mjs';
function glb(json) {
  const text = JSON.stringify(json);
  const bytes = Buffer.from(text + ' '.repeat((4 - Buffer.byteLength(text) % 4) % 4));
  const buffer = Buffer.alloc(20 + bytes.length);
  buffer.writeUInt32LE(0x46546c67, 0); buffer.writeUInt32LE(2, 4); buffer.writeUInt32LE(buffer.length, 8);
  buffer.writeUInt32LE(bytes.length, 12); buffer.writeUInt32LE(0x4e4f534a, 16); bytes.copy(buffer, 20);
  return buffer;
}
test('embedded VRM 1 and legacy VRM accepted', () => {
  for (const name of ['VRMC_vrm', 'VRM']) assert.ok(validateModel(glb({extensions: {[name]: {}}, buffers: [{byteLength: 0}], images: [{bufferView: 0}]})));
});
test('model resources cannot access local files, web services, or data URLs', () => {
  for (const field of ['images', 'buffers']) for (const uri of ['https://example.com/key','file:///C:/private.txt','../private.txt','data:text/plain,hello']) {
    assert.throws(() => validateModel(glb({extensions: {VRMC_vrm: {}}, [field]: [{uri}]})), /外部ファイル/);
  }
});
test('truncated or malformed GLB rejected before parser', () => {
  assert.throws(() => validateModel(Buffer.alloc(8)));
  const data = glb({extensions: {VRMC_vrm: {}}});
  data.writeUInt32LE(0xffffffff, 12);
  assert.throws(() => validateModel(data));
  assert.throws(() => validateModel(glb({asset: {version: '2.0'}})), /VRMモデル/);
});
