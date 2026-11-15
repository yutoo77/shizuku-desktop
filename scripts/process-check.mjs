import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);

// PID reuse is normal on Windows. Never identify a terminated app's process
// only by its numeric PID, and never kill a process from this inspection.
export function compareProcessIdentities(expected, current) {
  const remainingPids = [], reusedPids = [], unverifiablePids = [];
  for (const pid of new Set(expected.map(item => item.pid))) {
    const live = current.find(item => item.pid === pid);
    if (!live) continue;
    const matches = expected.filter(item => item.pid === pid).map(item => {
      if (Number.isFinite(item.creationTime)) {
        return Number.isFinite(live.creationTime) ? Math.abs(item.creationTime - live.creationTime) < 1 : null;
      }
      // Launchers/helpers without Electron's creationTime are identified by
      // their known image and parent; no arbitrary process is a cleanup target.
      if (item.name && Number.isInteger(item.parentPid)) {
        return typeof live.name === 'string' && Number.isInteger(live.parentPid)
          ? item.name.toLowerCase() === live.name.toLowerCase() && item.parentPid === live.parentPid : null;
      }
      return null;
    });
    if (matches.some(value => value === true)) remainingPids.push(pid);
    else if (matches.some(value => value === null)) unverifiablePids.push(pid);
    else reusedPids.push(pid);
  }
  return { remainingPids, reusedPids, unverifiablePids };
}

export async function inspectProcessIdentities(expected, directory) {
  const ids = [...new Set(expected.map(item => item.pid))];
  if (!ids.length || ids.length > 2048 || ids.some(pid => !Number.isSafeInteger(pid) || pid <= 0 || pid > 4294967295)) throw new Error('Invalid owned process identifiers');
  const input = path.join(directory, 'process-ids.json');
  await writeFile(input, JSON.stringify(ids));
  const env = { ...process.env }; delete env.OPENAI_API_KEY;
  const { stdout } = await exec('pwsh.exe', ['-NoProfile', '-File', path.join(path.dirname(fileURLToPath(import.meta.url)), 'process-check.ps1'), '-InputFile', input], {
    windowsHide: true, env, timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  const current = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  if (!Array.isArray(current)) throw new Error('Invalid process identity snapshot');
  return { ...compareProcessIdentities(expected, current), current };
}
