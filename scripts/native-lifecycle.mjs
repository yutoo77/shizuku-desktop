import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(path.join(root, 'work', 'native-lifetime-'));
const children = [], results = [];
function parent() {
  const p = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { windowsHide: true, stdio: 'pipe' });
  children.push(p); return p;
}
async function helper(parentPid) {
  const p = spawn(path.join(root, 'dist', 'window-tracker.exe'), [String(parentPid)], { windowsHide: true, stdio: 'pipe' });
  children.push(p);
  p.stdin.on('error', () => {}); p.stderr.resume(); p.stdout.setEncoding('utf8');
  let ready = false; p.stdout.on('data', text => { if (text.includes('"ready"')) ready = true; });
  for (let i = 0; i < 100 && !ready && p.exitCode === null; i++) await delay(30);
  assert.equal(ready, true); return p;
}
async function exited(p) {
  for (let i = 0; i < 100 && p.exitCode === null; i++) await delay(30);
  assert.notEqual(p.exitCode, null, 'Native helper must terminate within three seconds');
}
let failure;
try {
  let p = parent(), h = await helper(p.pid);
  p.stdin.end(); await exited(p); await exited(h);
  results.push('Parent termination closes the helper even while its command pipe remains open.');
  h = await helper(process.pid); h.stdin.end(); await exited(h);
  results.push('Command-pipe EOF closes the helper without requiring parent exit.');
  h = await helper(process.pid); h.stdin.write('not-a-command\n'); await exited(h);
  results.push('An unknown command exits without inspecting any window.');
  h = await helper(process.pid); h.stdin.write('x'.repeat(65)); await exited(h);
  results.push('An oversized unterminated command cannot grow an unbounded input buffer.');
  h = await helper(process.pid); h.stdin.write('test-select 1 123 123\n'); await exited(h);
  results.push('Normal helper mode rejects the fixture-only selection command.');
} catch (error) { failure = error; }
finally {
  for (const child of children) if (child.exitCode === null) { child.kill(); await once(child, 'close').catch(() => {}); }
  const remaining = children.filter(child => { try { process.kill(child.pid, 0); return true; } catch { return false; } }).map(child => child.pid);
  if (remaining.length) failure ??= new Error('Processes remain');
  await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', results, remainingPids: remaining, error: failure?.stack }, null, 2));
  console.log(JSON.stringify({ directory, passed: results.length, status: failure ? 'failed' : 'passed', remainingPids: remaining, error: failure?.message }));
}
if (failure) throw failure;
