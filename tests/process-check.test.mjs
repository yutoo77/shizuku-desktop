import test from 'node:test';
import assert from 'node:assert/strict';
import { compareProcessIdentities } from '../scripts/process-check.mjs';

test('PID reused by a later Windows process is not a remaining app process', () => {
  assert.deepEqual(compareProcessIdentities([{ pid: 12, creationTime: 100.8 }], [{ pid: 12, creationTime: 150, name: 'backgroundTaskHost.exe' }]),
    { remainingPids: [], reusedPids: [12], unverifiablePids: [] });
});
test('millisecond-truncated creation time still detects a surviving renderer', () => {
  assert.deepEqual(compareProcessIdentities([{ pid: 12, creationTime: 100.8 }], [{ pid: 12, creationTime: 100 }]),
    { remainingPids: [12], reusedPids: [], unverifiablePids: [] });
});
test('multiple incarnations of a PID retain a live matching process', () => {
  assert.deepEqual(compareProcessIdentities([{ pid: 12, creationTime: 100 }, { pid: 12, creationTime: 300 }], [{ pid: 12, creationTime: 300 }]),
    { remainingPids: [12], reusedPids: [], unverifiablePids: [] });
});
test('missing identity information cannot certify clean shutdown', () => {
  assert.deepEqual(compareProcessIdentities([{ pid: 12, creationTime: 100 }], [{ pid: 12 }]),
    { remainingPids: [], reusedPids: [], unverifiablePids: [12] });
});
test('helper and collector fallback checks both image and known parent', () => {
  const expected = [{ pid: 1, name: 'window-tracker.exe', parentPid: 20 }, { pid: 2, name: 'pwsh.exe', parentPid: 30 }];
  assert.deepEqual(compareProcessIdentities(expected, [{ pid: 1, name: 'WINDOW-TRACKER.EXE', parentPid: 20 }, { pid: 2, name: 'pwsh.exe', parentPid: 40 }]),
    { remainingPids: [1], reusedPids: [2], unverifiablePids: [] });
});
test('no live PID means all expected processes exited', () => {
  assert.deepEqual(compareProcessIdentities([{ pid: 12, creationTime: 100 }], []),
    { remainingPids: [], reusedPids: [], unverifiablePids: [] });
});
